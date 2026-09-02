using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Threading;
using Fsp;
using FileInfo = Fsp.Interop.FileInfo;
using VolumeInfo = Fsp.Interop.VolumeInfo;

namespace TmaCloud.Fs
{
    public sealed partial class CloudFileSystem
    {
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
                    // Idempotent mkdir: apps "ensure" a directory exists before
                    // saving, so reuse an existing same-name folder (in-session
                    // map first, proof against the ~60s listing cache, then a
                    // fresh lookup) rather than POSTing a duplicate.
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
            if (!IsSafeName(name)) return STATUS_ACCESS_DENIED;
            string tmp = NewTempFile();
            var stream = OpenStaging(tmp, FileMode.Create);
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
                    // Reuse the staging file if this handle already has one;
                    // a fresh temp would strand the old one until the sweep.
                    string tmp = of.LocalPath ?? NewTempFile();
                    of.LocalPath = tmp;
                    of.Stream = OpenStaging(tmp, FileMode.Create);
                }
                else
                {
                    of.Stream.SetLength(0);
                }
                of.Dirty = true;
                of.Node.Modified = DateTime.UtcNow;
                // Drop the stale read time too: writing counts as access, and the
                // backend restamps on replace, so the new write time is right
                // until the next listing brings the server's value.
                of.Node.Accessed = default;
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

    }
}
