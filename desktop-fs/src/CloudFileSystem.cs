using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text.Json;
using Fsp;
using FileInfo = Fsp.Interop.FileInfo;
using VolumeInfo = Fsp.Interop.VolumeInfo;

namespace TmaCloud.Fs
{
    /// <summary>
    /// A WinFsp filesystem that projects the TMA Cloud store (an id-addressed
    /// REST API) as a path-addressed Windows volume. All backend I/O is
    /// delegated to the Electron main process over <see cref="Bridge"/>, which
    /// holds the user's session cookies and performs the authenticated calls.
    ///
    /// Design notes:
    ///  - Path→id resolution walks cached directory listings from the root.
    ///  - File reads lazily download to a per-handle temp file, then serve from it.
    ///  - File writes stage to the same temp file and upload on last-handle
    ///    Cleanup (write-back), so a "Save As" from any app flows through the
    ///    normal upload/replace pipeline with all permissions/audit intact.
    /// </summary>
    public sealed class CloudFileSystem : FileSystemBase, IDisposable
    {
        // --- NTSTATUS codes we return (subset). These shadow the identical
        //     constants on FileSystemBase; declared locally with `new` so our
        //     Int32 typing is explicit and independent of the binding version. ---
        private new const int STATUS_SUCCESS = 0;
        private new const int STATUS_END_OF_FILE = unchecked((int)0xC0000011);
        private new const int STATUS_ACCESS_DENIED = unchecked((int)0xC0000022);
        private new const int STATUS_OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);
        private new const int STATUS_OBJECT_PATH_NOT_FOUND = unchecked((int)0xC000003A);
        private new const int STATUS_DIRECTORY_NOT_EMPTY = unchecked((int)0xC0000101);

        // --- WinFsp flag bits we care about. ---
        private new const uint FILE_DIRECTORY_FILE = 0x00000001;
        private const uint CLEANUP_DELETE = 0x00000001;

        private static readonly DateTime EpochFloor = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        private readonly Bridge _bridge;
        private readonly string _volumeLabel;
        private readonly string _stagingDir;
        private readonly TimeSpan _ttl = TimeSpan.FromSeconds(5);
        private readonly Node _root = Node.Root();
        private readonly ConcurrentDictionary<string, DirCache> _dirCache =
            new ConcurrentDictionary<string, DirCache>(StringComparer.OrdinalIgnoreCase);
        // Serializes new-file write-back so concurrent Cleanups for the same
        // "Save As" (placeholder + real content) can't both create a duplicate.
        private readonly object _uploadLock = new object();
        // Path -> backend id for files created in THIS session. Immune to the
        // backend's listing cache (Redis, ~60s), so a placeholder + content
        // pair for one path always resolves to a single backend file even
        // when a fresh list would still be stale.
        private readonly ConcurrentDictionary<string, string> _createdIds =
            new ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // Empty files created on the drive but NOT uploaded to the backend.
        // Apps create a 0-byte placeholder during "Save As", verify it exists,
        // then write the real content to a temp name and rename it over the
        // placeholder. We keep the placeholder here as a local-only file so
        // those steps work, but never materialize it on the backend (no S3
        // object, no DB row, no wasted quota). Set of full paths.
        private readonly ConcurrentDictionary<string, byte> _localEmpty =
            new ConcurrentDictionary<string, byte>(StringComparer.OrdinalIgnoreCase);
        private byte[] _defaultSecurity;

        // Volume size reported to Windows, refreshed from the backend's real
        // storage quota/usage (GET /api/user/storage). GetVolumeInfo is called
        // very frequently, so we serve cached values and refresh on a timer.
        private long _totalSize = 1L << 44; // placeholder until first refresh
        private long _freeSize = 1L << 43;
        private System.Threading.Timer _statsTimer;
        private int _refreshingStats;

        /// <summary>
        /// "Save-only" mode: when true, reading file CONTENT from the drive is
        /// denied (browsing folders, seeing files, and Save-As still work).
        /// Lets an admin force users to open files through the app while still
        /// allowing Save-As uploads. Toggled live via a "mode" push.
        /// </summary>
        public volatile bool DenyRead;

        public CloudFileSystem(Bridge bridge, string volumeLabel, bool denyRead = false)
        {
            _bridge = bridge;
            _volumeLabel = volumeLabel;
            DenyRead = denyRead;
            _stagingDir = Path.Combine(Path.GetTempPath(), "tma-cloud-fs");
            Directory.CreateDirectory(_stagingDir);
            CleanStagingDir();

            var sd = new RawSecurityDescriptor("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;WD)");
            _defaultSecurity = new byte[sd.BinaryLength];
            sd.GetBinaryForm(_defaultSecurity, 0);

            // Backend-driven cache invalidation (via the SSE event stream that
            // Electron forwards). A push clears either one folder or everything,
            // so changes from the web app / other clients surface immediately
            // rather than after the listing TTL.
            _bridge.OnPush = msg =>
            {
                try
                {
                    string push = msg.TryGetProperty("push", out var pv) ? pv.GetString() : null;
                    if (push == "mode")
                    {
                        string mode = msg.TryGetProperty("mode", out var mv) ? mv.GetString() : null;
                        DenyRead = string.Equals(mode, "saveonly", StringComparison.OrdinalIgnoreCase);
                        Log("mode set: denyRead=" + DenyRead);
                        return;
                    }
                    // invalidate
                    if (msg.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String)
                        Invalidate(p.GetString());
                    else
                        _dirCache.Clear();
                }
                catch { /* ignore */ }
            };

            // Refresh the reported volume size from the backend: once shortly
            // after mount, then every 30s.
            _statsTimer = new System.Threading.Timer(RefreshStats, null, 500, 30000);
        }

        /// <summary>Fetch real quota/usage and update the cached volume size.</summary>
        private void RefreshStats(object state)
        {
            if (System.Threading.Interlocked.Exchange(ref _refreshingStats, 1) == 1) return;
            try
            {
                var res = _bridge.Call("stats", null, 15000);
                if (res.ValueKind != JsonValueKind.Object) return;

                long used = res.TryGetProperty("used", out var u) ? ParseLong(u) : 0;
                bool hasTotal = res.TryGetProperty("total", out var t) && t.ValueKind != JsonValueKind.Null;
                if (hasTotal)
                {
                    long total = ParseLong(t);
                    long free = res.TryGetProperty("free", out var f) && f.ValueKind != JsonValueKind.Null
                        ? ParseLong(f)
                        : Math.Max(0, total - used);
                    if (total > 0) { _totalSize = total; _freeSize = Math.Max(0, free); }
                }
                else
                {
                    // Unlimited quota: present used + generous headroom so the
                    // drive doesn't look full.
                    const long headroom = 1L << 43; // 8 TiB
                    _totalSize = used + headroom;
                    _freeSize = headroom;
                }
            }
            catch { /* keep previous values */ }
            finally { System.Threading.Interlocked.Exchange(ref _refreshingStats, 0); }
        }

        // ============================ Volume ============================

        public override int Init(object Host)
        {
            var host = (FileSystemHost)Host;
            host.SectorSize = 4096;
            host.SectorsPerAllocationUnit = 1;
            host.MaxComponentLength = 255;
            host.VolumeCreationTime = (ulong)DateTime.UtcNow.ToFileTimeUtc();
            host.VolumeSerialNumber = (uint)(host.VolumeCreationTime / (10000UL * 1000UL));
            host.CaseSensitiveSearch = false;
            host.CasePreservedNames = true;
            host.UnicodeOnDisk = true;
            host.PersistentAcls = false;
            host.PostCleanupWhenModifiedOnly = false; // always get a final Cleanup
            host.FlushAndPurgeOnCleanup = true;
            return STATUS_SUCCESS;
        }

        public override int GetVolumeInfo(out VolumeInfo VolumeInfo)
        {
            VolumeInfo = default;
            VolumeInfo.TotalSize = (ulong)_totalSize;
            VolumeInfo.FreeSize = (ulong)_freeSize;
            VolumeInfo.SetVolumeLabel(_volumeLabel);
            return STATUS_SUCCESS;
        }

        public override int SetVolumeLabel(string VolumeLabel, out VolumeInfo VolumeInfo)
            => GetVolumeInfo(out VolumeInfo);

        // ============================ Lookup ============================

        public override int GetSecurityByName(string FileName, out uint FileAttributes,
            ref byte[] SecurityDescriptor)
        {
            FileAttributes = 0;
            Node node;
            try { node = Resolve(FileName); }
            catch (BridgeException) { return STATUS_OBJECT_PATH_NOT_FOUND; }
            if (node == null) return STATUS_OBJECT_NAME_NOT_FOUND;

            FileAttributes = node.IsFolder
                ? (uint)System.IO.FileAttributes.Directory
                : (uint)System.IO.FileAttributes.Normal;
            if (SecurityDescriptor != null)
                SecurityDescriptor = _defaultSecurity;
            return STATUS_SUCCESS;
        }

        public override int Open(string FileName, uint CreateOptions, uint GrantedAccess,
            out object FileNode, out object FileDesc, out FileInfo FileInfo, out string NormalizedName)
        {
            FileNode = null; FileDesc = null; FileInfo = default; NormalizedName = null;
            Node node;
            try { node = Resolve(FileName); }
            catch (BridgeException ex) { Log("open resolve failed: " + ex.Message); return STATUS_OBJECT_PATH_NOT_FOUND; }
            if (node == null) return STATUS_OBJECT_NAME_NOT_FOUND;

            var of = new OpenFile { Node = node, IsDir = node.IsFolder };
            // A local-only empty placeholder (not on the backend): open it as a
            // new file so that if content is written it uploads for real, and if
            // not it stays a placeholder.
            if (!node.IsFolder && node.Id == null)
            {
                of.IsNew = true;
                of.NewName = node.Name;
                try { of.Parent = Resolve(ParentPath(node.Path)); } catch (BridgeException) { of.Parent = null; }
            }
            FileDesc = of;
            FileInfo = MakeInfoFromNode(node);
            NormalizedName = node.Path; // WinFsp expects the full normalized path
            return STATUS_SUCCESS;
        }

        public override int Create(string FileName, uint CreateOptions, uint GrantedAccess,
            uint FileAttributes, byte[] SecurityDescriptor, ulong AllocationSize,
            out object FileNode, out object FileDesc, out FileInfo FileInfo, out string NormalizedName)
        {
            FileNode = null; FileDesc = null; FileInfo = default; NormalizedName = null;

            string parentPath = ParentPath(FileName);
            string name = LeafName(FileName);
            if (parentPath == null || name.Length == 0)
                return STATUS_ACCESS_DENIED; // cannot create the root itself

            Node parent;
            try { parent = Resolve(parentPath); }
            catch (BridgeException) { return STATUS_OBJECT_PATH_NOT_FOUND; }
            if (parent == null || !parent.IsFolder)
                return STATUS_OBJECT_PATH_NOT_FOUND;

            bool isDir = (CreateOptions & FILE_DIRECTORY_FILE) != 0;
            if (isDir)
            {
                string folderPath = Combine(parentPath, name);
                lock (_uploadLock)
                {
                    // Idempotent mkdir. Apps and Explorer "ensure" a directory
                    // exists (CreateDirectory) before saving into it; if we
                    // always POST a new folder we get duplicate folders. Reuse
                    // an existing same-name folder (in-session map first — proof
                    // against the backend's ~60s listing cache — then a fresh
                    // backend lookup).
                    string existingId = null;
                    if (_createdIds.TryGetValue(folderPath, out var cid))
                        existingId = cid;
                    else
                    {
                        var ef = FindChildByName(parent.Id, name, wantFolder: true);
                        if (ef != null) existingId = ef.Id;
                    }

                    Node node;
                    if (existingId != null)
                    {
                        node = new Node { Id = existingId, Name = name, IsFolder = true, Modified = DateTime.UtcNow, Path = folderPath };
                    }
                    else
                    {
                        JsonElement res;
                        try
                        {
                            res = _bridge.Call("mkdir", w =>
                            {
                                w.WriteString("name", name);
                                if (parent.Id != null) w.WriteString("parentId", parent.Id);
                            });
                        }
                        catch (BridgeException ex) { Log("mkdir failed: " + ex.Message); return STATUS_ACCESS_DENIED; }

                        node = NodeFromJson(res, parentPath) ?? new Node
                        {
                            Id = GetIdString(res),
                            Name = name,
                            IsFolder = true,
                            Modified = DateTime.UtcNow,
                            Path = folderPath,
                        };
                    }

                    TrackCreatedId(folderPath, node.Id);
                    Invalidate(parentPath);
                    var od = new OpenFile { Node = node, IsDir = true };
                    FileDesc = od;
                    FileInfo = MakeInfoFromNode(node);
                    NormalizedName = node.Path;
                    return STATUS_SUCCESS;
                }
            }

            // New file: stage locally now, upload on Cleanup.
            string tmp = NewTempFile();
            var stream = new FileStream(tmp, FileMode.Create, FileAccess.ReadWrite, FileShare.None);
            var fnode = new Node
            {
                Id = null,
                Name = name,
                IsFolder = false,
                Size = 0,
                Modified = DateTime.UtcNow,
                Path = Combine(parentPath, name),
            };
            var of = new OpenFile
            {
                Node = fnode,
                IsDir = false,
                IsNew = true,
                Parent = parent,
                NewName = name,
                LocalPath = tmp,
                Stream = stream,
                Dirty = true,
            };
            FileDesc = of;
            FileInfo = MakeInfo(of);
            NormalizedName = fnode.Path;
            return STATUS_SUCCESS;
        }

        public override int Overwrite(object FileNode, object FileDesc, uint FileAttributes,
            bool ReplaceFileAttributes, ulong AllocationSize, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            lock (of.Lock)
            {
                if (of.Stream == null)
                {
                    string tmp = NewTempFile();
                    of.LocalPath = tmp;
                    of.Stream = new FileStream(tmp, FileMode.Create, FileAccess.ReadWrite, FileShare.None);
                }
                else
                {
                    of.Stream.SetLength(0);
                }
                of.Dirty = true;
                of.Node.Modified = DateTime.UtcNow;
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

        // ============================ Read/Write ============================

        public override int Read(object FileNode, object FileDesc, IntPtr Buffer, ulong Offset,
            uint Length, out uint BytesTransferred)
        {
            var of = (OpenFile)FileDesc;
            BytesTransferred = 0;
            // Save-only mode: allow reading back content we're staging in THIS
            // session (so Save-As / edit flows keep working) but deny reading
            // existing cloud files off the drive.
            if (DenyRead && !of.IsNew && of.Stream == null)
                return STATUS_ACCESS_DENIED;
            lock (of.Lock)
            {
                try { EnsureStream(of); }
                catch (BridgeException ex) { Log("read download failed: " + ex.Message); return STATUS_OBJECT_NAME_NOT_FOUND; }

                long size = of.Stream.Length;
                if ((long)Offset >= size) return STATUS_END_OF_FILE;

                int toRead = (int)Math.Min((long)Length, size - (long)Offset);
                var buf = new byte[toRead];
                of.Stream.Seek((long)Offset, SeekOrigin.Begin);
                int read = 0;
                while (read < toRead)
                {
                    int r = of.Stream.Read(buf, read, toRead - read);
                    if (r <= 0) break;
                    read += r;
                }
                Marshal.Copy(buf, 0, Buffer, read);
                BytesTransferred = (uint)read;
            }
            return STATUS_SUCCESS;
        }

        public override int Write(object FileNode, object FileDesc, IntPtr Buffer, ulong Offset,
            uint Length, bool WriteToEndOfFile, bool ConstrainedIo,
            out uint BytesTransferred, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            BytesTransferred = 0;
            lock (of.Lock)
            {
                try { EnsureStream(of); }
                catch (BridgeException ex) { Log("write stage failed: " + ex.Message); FileInfo = MakeInfo(of); return STATUS_ACCESS_DENIED; }

                long size = of.Stream.Length;
                long offset = WriteToEndOfFile ? size : (long)Offset;
                uint len = Length;
                if (ConstrainedIo)
                {
                    if (offset >= size) { FileInfo = MakeInfo(of); return STATUS_SUCCESS; }
                    if (offset + len > size) len = (uint)(size - offset);
                }

                var buf = new byte[len];
                Marshal.Copy(Buffer, buf, 0, (int)len);
                of.Stream.Seek(offset, SeekOrigin.Begin);
                of.Stream.Write(buf, 0, (int)len);
                of.Dirty = true;
                of.Written = true;
                BytesTransferred = len;
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

        public override int Flush(object FileNode, object FileDesc, out FileInfo FileInfo)
        {
            var of = FileDesc as OpenFile;
            if (of == null) { FileInfo = default; return STATUS_SUCCESS; }
            lock (of.Lock)
            {
                try { of.Stream?.Flush(); } catch { }
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

        public override int GetFileInfo(object FileNode, object FileDesc, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            lock (of.Lock) { FileInfo = MakeInfo(of); }
            return STATUS_SUCCESS;
        }

        public override int SetBasicInfo(object FileNode, object FileDesc, uint FileAttributes,
            ulong CreationTime, ulong LastAccessTime, ulong LastWriteTime, ulong ChangeTime,
            out FileInfo FileInfo)
        {
            // Timestamps/attributes on the cloud are managed by the backend; we
            // accept the request so apps don't fail, and report current info.
            var of = (OpenFile)FileDesc;
            lock (of.Lock) { FileInfo = MakeInfo(of); }
            return STATUS_SUCCESS;
        }

        public override int SetFileSize(object FileNode, object FileDesc, ulong NewSize,
            bool SetAllocationSize, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            lock (of.Lock)
            {
                if (!SetAllocationSize)
                {
                    try { EnsureStream(of); of.Stream.SetLength((long)NewSize); of.Dirty = true; }
                    catch (BridgeException ex) { Log("setsize failed: " + ex.Message); }
                }
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

        // ============================ Delete/Rename ============================

        public override int CanDelete(object FileNode, object FileDesc, string FileName)
        {
            var of = (OpenFile)FileDesc;
            if (of.IsDir && of.Node.Id == null) return STATUS_ACCESS_DENIED; // root
            if (of.IsDir)
            {
                try { if (ListDir(of.Node).Count > 0) return STATUS_DIRECTORY_NOT_EMPTY; }
                catch (BridgeException) { /* allow; backend will enforce */ }
            }
            return STATUS_SUCCESS;
        }

        public override int Rename(object FileNode, object FileDesc, string FileName,
            string NewFileName, bool ReplaceIfExists)
        {
            Node node;
            try { node = Resolve(FileName); }
            catch (BridgeException) { return STATUS_OBJECT_PATH_NOT_FOUND; }
            if (node == null) return STATUS_OBJECT_NAME_NOT_FOUND;

            string oldParent = ParentPath(FileName);
            string newParent = ParentPath(NewFileName);
            string newName = LeafName(NewFileName);

            // Source is a local-only empty placeholder (never uploaded): just
            // move the local entry, no backend operation.
            if (node.Id == null)
            {
                _localEmpty.TryRemove(FileName, out _);
                _localEmpty.TryRemove(NewFileName, out _);
                TrackLocalEmpty(NewFileName);
                Invalidate(oldParent);
                Invalidate(newParent);
                return STATUS_SUCCESS;
            }

            try
            {
                // If a local-only placeholder occupies the destination name, just
                // forget it — it was never on the backend, so the rename replaces
                // it with a single real file (no upload, no delete, no garbage).
                _localEmpty.TryRemove(NewFileName, out _);

                // Honor ReplaceIfExists for a real destination file: remove
                // whatever already occupies the target name so the rename yields
                // a single file.
                Node newParentNode = Resolve(newParent);
                string newParentId = newParentNode?.Id;

                string conflictId = null;
                if (_createdIds.TryGetValue(NewFileName, out var cId) && cId != node.Id)
                {
                    conflictId = cId;
                }
                else
                {
                    var destExisting = FindFileByName(newParentId, newName);
                    if (destExisting != null && destExisting.Id != node.Id) conflictId = destExisting.Id;
                }
                if (conflictId != null)
                {
                    // Honor ReplaceIfExists: remove whatever already occupies the
                    // destination name so the rename yields a single file.
                    try
                    {
                        _bridge.Call("delete", w =>
                        {
                            w.WriteStartArray("ids");
                            w.WriteStringValue(conflictId);
                            w.WriteEndArray();
                        });
                    }
                    catch (BridgeException ex) { Log("rename: delete conflict failed: " + ex.Message); }
                    _createdIds.TryRemove(NewFileName, out _);
                }

                if (!string.Equals(oldParent, newParent, StringComparison.OrdinalIgnoreCase))
                {
                    if (newParentNode == null || !newParentNode.IsFolder) return STATUS_OBJECT_PATH_NOT_FOUND;
                    _bridge.Call("move", w =>
                    {
                        w.WriteStartArray("ids");
                        w.WriteStringValue(node.Id);
                        w.WriteEndArray();
                        if (newParentId != null) w.WriteString("parentId", newParentId);
                    });
                    Invalidate(newParent);
                }
                if (!string.Equals(LeafName(FileName), newName, StringComparison.Ordinal))
                {
                    _bridge.Call("rename", w =>
                    {
                        w.WriteString("id", node.Id);
                        w.WriteString("name", newName);
                    });
                }
                _createdIds.TryRemove(FileName, out _);        // old path no longer valid
                TrackCreatedId(NewFileName, node.Id);          // track the file at its new path
                Invalidate(oldParent);
                Invalidate(newParent);
                return STATUS_SUCCESS;
            }
            catch (BridgeException ex) { Log("rename failed: " + ex.Message); return STATUS_ACCESS_DENIED; }
        }

        public override void Cleanup(object FileNode, object FileDesc, string FileName, uint Flags)
        {
            var of = FileDesc as OpenFile;
            if (of == null) return;
            lock (of.Lock)
            {
                if ((Flags & CLEANUP_DELETE) != 0)
                {
                    try
                    {
                        // A local-only placeholder isn't on the backend — just
                        // forget it; only real files need a backend delete.
                        if (of.Node.Id != null)
                            _bridge.Call("delete", w =>
                            {
                                w.WriteStartArray("ids");
                                w.WriteStringValue(of.Node.Id);
                                w.WriteEndArray();
                            });
                    }
                    catch (BridgeException ex) { Log("delete failed: " + ex.Message); }
                    of.Deleted = true;
                    if (of.Node.Path != null)
                    {
                        _createdIds.TryRemove(of.Node.Path, out _);
                        _localEmpty.TryRemove(of.Node.Path, out _);
                    }
                    Invalidate(ParentPath(of.Node.Path) ?? "\\");
                    return;
                }

                if (of.Dirty && !of.Deleted)
                {
                    // Release our exclusive handle on the staging file BEFORE
                    // uploading: the bridge runs in another process and must be
                    // able to open the temp file to stream it. Cleanup is the
                    // last-handle signal, so no further Read/Write will occur.
                    try { of.Stream?.Flush(); of.Stream?.Dispose(); } catch { }
                    of.Stream = null;

                    long staged = 0;
                    try { staged = new System.IO.FileInfo(of.LocalPath).Length; } catch { /* ignore */ }

                    if (of.IsNew && !of.Written && staged == 0)
                    {
                        // Empty, never-written new file: keep it as a local-only
                        // placeholder rather than creating a 0-byte backend file.
                        TrackLocalEmpty(of.Node.Path);
                    }
                    else
                    {
                        try { UploadBack(of); _localEmpty.TryRemove(of.Node.Path, out _); }
                        catch (BridgeException ex) { Log("upload failed: " + ex.Message); }
                    }
                    of.Dirty = false;
                }
            }
        }

        public override void Close(object FileNode, object FileDesc)
        {
            var of = FileDesc as OpenFile;
            if (of == null) return;
            lock (of.Lock)
            {
                try { of.Stream?.Dispose(); } catch { }
                of.Stream = null;
                if (of.LocalPath != null)
                {
                    try { File.Delete(of.LocalPath); } catch { }
                    of.LocalPath = null;
                }
            }
        }

        // ============================ Security ============================

        public override int GetSecurity(object FileNode, object FileDesc, ref byte[] SecurityDescriptor)
        {
            SecurityDescriptor = _defaultSecurity;
            return STATUS_SUCCESS;
        }

        public override int SetSecurity(object FileNode, object FileDesc,
            AccessControlSections Sections, byte[] SecurityDescriptor)
            => STATUS_SUCCESS;

        // ============================ Directory ============================

        private sealed class DirEntry
        {
            public string Name;
            public FileInfo Info;
        }

        private sealed class DirEnum
        {
            public List<DirEntry> Entries;
            public int Index;
        }

        public override bool ReadDirectoryEntry(object FileNode, object FileDesc, string Pattern,
            string Marker, ref object Context, out string FileName, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            var en = Context as DirEnum;
            if (en == null)
            {
                try { en = BuildDirEnum(of.Node, Marker); }
                catch (BridgeException ex)
                {
                    Log("readdir failed: " + ex.Message);
                    en = new DirEnum { Entries = new List<DirEntry>(), Index = 0 };
                }
                Context = en;
            }

            if (en.Index >= en.Entries.Count) { FileName = null; FileInfo = default; return false; }
            var e = en.Entries[en.Index++];
            FileName = e.Name;
            FileInfo = e.Info;
            return true;
        }

        private DirEnum BuildDirEnum(Node folder, string marker)
        {
            var list = new List<DirEntry>();
            if (folder.Path != "\\")
            {
                var dirInfo = MakeInfoFolder(folder.Modified);
                list.Add(new DirEntry { Name = ".", Info = dirInfo });
                list.Add(new DirEntry { Name = "..", Info = dirInfo });
            }
            foreach (var c in ChildrenOf(folder))
                list.Add(new DirEntry { Name = c.Name, Info = MakeInfoFromNode(c) });

            int start = 0;
            if (!string.IsNullOrEmpty(marker))
            {
                for (int i = 0; i < list.Count; i++)
                    if (string.Equals(list[i].Name, marker, StringComparison.OrdinalIgnoreCase))
                    {
                        start = i + 1;
                        break;
                    }
            }
            return new DirEnum { Entries = list.GetRange(start, list.Count - start), Index = 0 };
        }

        // ============================ Backend plumbing ============================

        private void UploadBack(OpenFile of)
        {
            string src = of.LocalPath;
            if (src == null) return;
            of.Stream?.Flush();

            if (of.IsNew || of.Node.Id == null)
            {
                string parentId = of.Parent?.Id;
                string name = of.NewName ?? of.Node.Name;
                long srcLen = 0;
                try { srcLen = new System.IO.FileInfo(src).Length; } catch { /* ignore */ }

                // CREATE_ALWAYS semantics + de-duplication. Apps often create a
                // 0-byte placeholder, then write the real content on a second
                // handle; both would otherwise POST a new file and the backend
                // allows duplicate names. Resolve a single target per path so a
                // save yields exactly one file.
                string fullPath = of.Node.Path;
                lock (_uploadLock)
                {
                    // Prefer the in-session map (cache-proof); fall back to a
                    // backend listing for files not created this session.
                    string targetId = null;
                    bool targetHasContent = false;
                    if (_createdIds.TryGetValue(fullPath, out var known))
                    {
                        targetId = known;
                        targetHasContent = true; // don't let a later empty clobber it
                    }
                    else
                    {
                        var existing = FindFileByName(parentId, name);
                        if (existing != null) { targetId = existing.Id; targetHasContent = existing.Size > 0; }
                    }

                    if (targetId != null)
                    {
                        if (srcLen == 0 && targetHasContent)
                        {
                            // A stray empty placeholder must not clobber real content.
                            of.Node.Id = targetId;
                            of.IsNew = false;
                            return;
                        }
                        try
                        {
                            _bridge.Call("replace", w =>
                            {
                                w.WriteString("id", targetId);
                                w.WriteString("name", name);
                                w.WriteString("src", src);
                            });
                            of.Node.Id = targetId;
                            of.IsNew = false;
                            TrackCreatedId(fullPath, targetId);
                        }
                        catch (BridgeException ex)
                        {
                            // Stale id (e.g. the file was deleted) — create fresh.
                            Log("uploadback: replace failed, uploading new: " + ex.Message);
                            targetId = null;
                        }
                    }
                    if (targetId == null)
                    {
                        var res = _bridge.Call("upload", w =>
                        {
                            if (parentId != null) w.WriteString("parentId", parentId);
                            w.WriteString("name", name);
                            w.WriteString("src", src);
                        });
                        string id = GetIdString(res);
                        if (id != null) { of.Node.Id = id; of.IsNew = false; TrackCreatedId(fullPath, id); }
                    }
                    Invalidate(of.Parent?.Path ?? "\\");
                }
            }
            else
            {
                _bridge.Call("replace", w =>
                {
                    w.WriteString("id", of.Node.Id);
                    w.WriteString("name", of.Node.Name);
                    w.WriteString("src", src);
                });
                Invalidate(ParentPath(of.Node.Path) ?? "\\");
            }
        }

        private Node FindFileByName(string parentId, string name)
            => FindChildByName(parentId, name, wantFolder: false);

        /// <summary>
        /// Fresh (uncached) lookup of a child by name and kind within a parent
        /// folder. Enforces idempotent create semantics (no duplicate files on
        /// Save-As, no duplicate folders on mkdir).
        /// </summary>
        private Node FindChildByName(string parentId, string name, bool wantFolder)
        {
            var res = _bridge.Call("list", w =>
            {
                if (parentId != null) w.WriteString("parentId", parentId);
            });
            if (res.ValueKind == JsonValueKind.Array)
                foreach (var el in res.EnumerateArray())
                {
                    if (el.ValueKind != JsonValueKind.Object) continue;
                    string type = el.TryGetProperty("type", out var tp) ? tp.GetString() : "file";
                    bool isFolder = string.Equals(type, "folder", StringComparison.OrdinalIgnoreCase);
                    if (isFolder != wantFolder) continue;
                    string nm = el.TryGetProperty("name", out var np) ? np.GetString() : null;
                    if (!string.Equals(nm, name, StringComparison.OrdinalIgnoreCase)) continue;
                    long size = el.TryGetProperty("size", out var sp) ? ParseLong(sp) : 0;
                    return new Node
                    {
                        Id = el.TryGetProperty("id", out var idp) ? JsonToStringId(idp) : null,
                        Name = nm,
                        IsFolder = isFolder,
                        Size = size,
                    };
                }
            return null;
        }

        /// <summary>Ensure the handle has a local staging stream with content.</summary>
        private void EnsureStream(OpenFile of)
        {
            if (of.Stream != null) return;
            string tmp = NewTempFile();
            if (of.Node.Id != null)
            {
                _bridge.Call("download", w =>
                {
                    w.WriteString("id", of.Node.Id);
                    w.WriteString("dest", tmp);
                });
            }
            else
            {
                using (File.Create(tmp)) { }
            }
            of.LocalPath = tmp;
            of.Stream = new FileStream(tmp, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }

        /// <summary>
        /// Backend children of a folder plus any local-only empty placeholders
        /// that live directly in it. Used everywhere a directory is enumerated
        /// so placeholders appear to exist without being on the backend.
        /// </summary>
        private List<Node> ChildrenOf(Node folder)
        {
            var children = ListDir(folder);
            if (_localEmpty.IsEmpty) return children;

            List<Node> merged = null;
            foreach (var kv in _localEmpty)
            {
                string p = kv.Key;
                if (!string.Equals(ParentPath(p), folder.Path, StringComparison.OrdinalIgnoreCase)) continue;
                string leaf = LeafName(p);
                bool onBackend = false;
                foreach (var c in children)
                    if (string.Equals(c.Name, leaf, StringComparison.OrdinalIgnoreCase)) { onBackend = true; break; }
                if (onBackend) continue;
                (merged ??= new List<Node>(children)).Add(new Node
                {
                    Id = null,
                    Name = leaf,
                    IsFolder = false,
                    Size = 0,
                    Modified = DateTime.UtcNow,
                    Path = p,
                });
            }
            return merged ?? children;
        }

        private List<Node> ListDir(Node folder)
        {
            string key = folder.Path;
            if (_dirCache.TryGetValue(key, out var dc) && dc.IsFresh(_ttl))
                return dc.Children;

            var res = _bridge.Call("list", w =>
            {
                if (folder.Id != null) w.WriteString("parentId", folder.Id);
            });

            var children = new List<Node>();
            if (res.ValueKind == JsonValueKind.Array)
                foreach (var el in res.EnumerateArray())
                {
                    var n = NodeFromJson(el, folder.Path);
                    if (n != null) children.Add(n);
                }

            // Keep the listing cache bounded; it just re-populates on demand.
            if (!_dirCache.ContainsKey(key) && _dirCache.Count >= MaxDirCache) _dirCache.Clear();
            _dirCache[key] = new DirCache { Children = children, FetchedUtc = DateTime.UtcNow };
            return children;
        }

        private Node Resolve(string path)
        {
            if (string.IsNullOrEmpty(path) || path == "\\") return _root;
            var parts = path.Trim('\\').Split('\\');
            Node cur = _root;
            foreach (var part in parts)
            {
                if (part.Length == 0) continue;
                if (!cur.IsFolder) return null;
                Node next = null;
                foreach (var c in ChildrenOf(cur))
                    if (string.Equals(c.Name, part, StringComparison.OrdinalIgnoreCase)) { next = c; break; }
                if (next == null) return null;
                cur = next;
            }
            return cur;
        }

        private void Invalidate(string dirPath)
        {
            if (dirPath == null) return;
            _dirCache.TryRemove(dirPath, out _);
        }

        // ============================ Helpers ============================

        private string NewTempFile()
            => Path.Combine(_stagingDir, Guid.NewGuid().ToString("N") + ".tmp");

        /// <summary>Remove stale staging files left behind by a previous crash.</summary>
        private void CleanStagingDir()
        {
            try
            {
                var cutoff = DateTime.UtcNow.AddHours(-1);
                foreach (var f in Directory.EnumerateFiles(_stagingDir, "*.tmp"))
                {
                    try { if (File.GetLastWriteTimeUtc(f) < cutoff) File.Delete(f); }
                    catch { /* in use or gone */ }
                }
            }
            catch { /* ignore */ }
        }

        // Record a path -> backend id, keeping the map bounded. These entries are
        // only needed to de-duplicate the create/rename dance of a single save,
        // so dropping the whole map on overflow is safe (FindChildByName is the
        // fallback).
        private const int MaxCreatedIds = 4096;
        private const int MaxDirCache = 1024;
        private const int MaxLocalEmpty = 4096;
        private void TrackCreatedId(string path, string id)
        {
            if (path == null || id == null) return;
            if (_createdIds.Count >= MaxCreatedIds) _createdIds.Clear();
            _createdIds[path] = id;
        }
        private void TrackLocalEmpty(string path)
        {
            if (path == null) return;
            if (_localEmpty.Count >= MaxLocalEmpty) _localEmpty.Clear();
            _localEmpty[path] = 0;
        }

        private static string ParentPath(string path)
        {
            if (path == "\\") return null;
            int i = path.LastIndexOf('\\');
            return i <= 0 ? "\\" : path.Substring(0, i);
        }

        private static string LeafName(string path)
        {
            if (path == "\\") return "";
            int i = path.LastIndexOf('\\');
            return path.Substring(i + 1);
        }

        private static string Combine(string dir, string name)
            => dir == "\\" ? "\\" + name : dir + "\\" + name;

        private static FileInfo MakeInfoFromNode(Node n)
        {
            var info = new FileInfo();
            info.FileAttributes = n.IsFolder
                ? (uint)System.IO.FileAttributes.Directory
                : (uint)System.IO.FileAttributes.Normal;
            info.FileSize = n.IsFolder ? 0UL : (ulong)Math.Max(0, n.Size);
            info.AllocationSize = (info.FileSize + 4095) & ~4095UL;
            ulong ft = ToFileTime(n.Modified);
            info.CreationTime = info.LastAccessTime = info.LastWriteTime = info.ChangeTime = ft;
            return info;
        }

        private static FileInfo MakeInfo(OpenFile of)
        {
            if (of.IsDir) return MakeInfoFromNode(of.Node);
            var info = new FileInfo();
            info.FileAttributes = (uint)System.IO.FileAttributes.Normal;
            info.FileSize = (ulong)Math.Max(0, of.CurrentSize);
            info.AllocationSize = (info.FileSize + 4095) & ~4095UL;
            ulong ft = ToFileTime(of.Node.Modified);
            info.CreationTime = info.LastAccessTime = info.LastWriteTime = info.ChangeTime = ft;
            return info;
        }

        private static FileInfo MakeInfoFolder(DateTime modified)
        {
            var info = new FileInfo();
            info.FileAttributes = (uint)System.IO.FileAttributes.Directory;
            ulong ft = ToFileTime(modified);
            info.CreationTime = info.LastAccessTime = info.LastWriteTime = info.ChangeTime = ft;
            return info;
        }

        private static ulong ToFileTime(DateTime dt)
        {
            if (dt == default || dt < EpochFloor) dt = DateTime.UtcNow;
            try { return (ulong)dt.ToUniversalTime().ToFileTimeUtc(); }
            catch { return (ulong)DateTime.UtcNow.ToFileTimeUtc(); }
        }

        private static string GetIdString(JsonElement el, string prop = "id")
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(prop, out var p))
                return JsonToStringId(p);
            return null;
        }

        private static string JsonToStringId(JsonElement p) => p.ValueKind switch
        {
            JsonValueKind.String => p.GetString(),
            JsonValueKind.Number => p.GetRawText(),
            _ => null,
        };

        // Parse a numeric value that may arrive as a JSON number OR a string
        // (node-postgres serializes BIGINT columns like `size` as strings).
        private static long ParseLong(JsonElement e)
        {
            try
            {
                if (e.ValueKind == JsonValueKind.Number) return e.GetInt64();
                if (e.ValueKind == JsonValueKind.String &&
                    long.TryParse(e.GetString(), out var v)) return v;
            }
            catch { /* ignore */ }
            return 0;
        }

        private static Node NodeFromJson(JsonElement el, string parentPath)
        {
            if (el.ValueKind != JsonValueKind.Object) return null;
            string name = el.TryGetProperty("name", out var np) ? np.GetString() : null;
            if (string.IsNullOrEmpty(name)) return null;
            string id = el.TryGetProperty("id", out var idp) ? JsonToStringId(idp) : null;
            string type = el.TryGetProperty("type", out var tp) ? tp.GetString() : "file";
            bool isFolder = string.Equals(type, "folder", StringComparison.OrdinalIgnoreCase);
            long size = el.TryGetProperty("size", out var sp) ? ParseLong(sp) : 0;
            DateTime mod = DateTime.UtcNow;
            if (el.TryGetProperty("modified", out var mp)) mod = ParseDate(mp);
            return new Node
            {
                Id = id,
                Name = name,
                IsFolder = isFolder,
                Size = size,
                Modified = mod,
                Path = Combine(parentPath, name),
            };
        }

        private static DateTime ParseDate(JsonElement mp)
        {
            try
            {
                if (mp.ValueKind == JsonValueKind.String)
                {
                    if (DateTime.TryParse(mp.GetString(), CultureInfo.InvariantCulture,
                        DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d))
                        return d;
                }
                else if (mp.ValueKind == JsonValueKind.Number)
                {
                    return DateTimeOffset.FromUnixTimeMilliseconds(mp.GetInt64()).UtcDateTime;
                }
            }
            catch { }
            return DateTime.UtcNow;
        }

        private static void Log(string msg)
        {
            try { Console.Error.WriteLine("[fs] " + msg); } catch { }
        }

        public void Dispose()
        {
            try { _statsTimer?.Dispose(); } catch { }
        }
    }
}
