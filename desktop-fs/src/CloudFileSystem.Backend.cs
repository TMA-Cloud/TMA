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

                // De-dupe: apps create a 0-byte placeholder then write content on
                // a second handle; both would POST a new file (the backend allows
                // duplicate names). Resolve one target per path so a save yields
                // exactly one file.
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

        /// <summary>Raw "list" call for one folder id (null == root).</summary>
        private JsonElement ListRaw(string parentId)
            => _bridge.Call("list", w =>
            {
                if (parentId != null) w.WriteString("parentId", parentId);
            });

        /// <summary>Delete one backend object by id.</summary>
        private void DeleteId(string id)
            => _bridge.Call("delete", w =>
            {
                w.WriteStartArray("ids");
                w.WriteStringValue(id);
                w.WriteEndArray();
            });

        // Fresh (uncached) lookup of a child by name and kind, so create stays
        // idempotent (no duplicate files on Save-As, no duplicate folders on mkdir).
        private Node FindChildByName(string parentId, string name, bool wantFolder)
        {
            var res = ListRaw(parentId);
            if (res.ValueKind == JsonValueKind.Array)
                foreach (var el in res.EnumerateArray())
                {
                    // Callers read only Id and Size, so the parent path is
                    // irrelevant; sharing the parser keeps validation in one place.
                    var n = NodeFromJson(el, "\\");
                    if (n == null || n.IsFolder != wantFolder) continue;
                    if (!string.Equals(n.Name, name, StringComparison.OrdinalIgnoreCase)) continue;
                    return n;
                }
            return null;
        }

        // Staging file for one handle, opened exclusive; Cleanup releases it
        // before the bridge streams it.
        private static FileStream OpenStaging(string path, FileMode mode)
            => new FileStream(path, mode, FileAccess.ReadWrite, FileShare.None);

        /// <summary>Ensure the handle has a local staging stream with content.</summary>
        private void EnsureStream(OpenFile of)
        {
            if (of.Stream != null) return;
            // An existing LocalPath means this handle already staged once; reuse
            // it rather than leaving the old temp file behind.
            bool reuse = of.LocalPath != null;
            string tmp = of.LocalPath ?? NewTempFile();
            try
            {
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
                of.Stream = OpenStaging(tmp, FileMode.Open);
            }
            catch
            {
                // A failed download may still have created the destination,
                // which nothing points at once we rethrow.
                if (!reuse)
                {
                    try { File.Delete(tmp); } catch { /* never created */ }
                }
                throw;
            }
        }

        // Backend children of a folder plus any local-only placeholders in it,
        // so placeholders appear to exist everywhere a directory is enumerated.
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

            var res = ListRaw(folder.Id);

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

    }
}
