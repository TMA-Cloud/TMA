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
        private string NewTempFile()
            => Path.Combine(_stagingDir, Guid.NewGuid().ToString("N") + ".tmp");

        // Drop crash-stale staging files at startup; drop them all on unmount
        // (all=true) so contents don't linger in %TEMP% after the drive is gone.
        private void CleanStagingDir(bool all = false)
        {
            try
            {
                var cutoff = DateTime.UtcNow.AddHours(-1);
                foreach (var f in Directory.EnumerateFiles(_stagingDir, "*.tmp"))
                {
                    try { if (all || File.GetLastWriteTimeUtc(f) < cutoff) File.Delete(f); }
                    catch { /* in use or gone */ }
                }
            }
            catch { /* ignore */ }
        }

        // Record a path -> backend id, bounded. Only needed to de-dupe a single
        // save's create/rename dance, so dropping the map on overflow is safe
        // (FindChildByName is the fallback).
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

        /// <summary>Whether <paramref name="path"/> is <paramref name="root"/> or sits under it.</summary>
        private static bool IsAtOrUnder(string path, string root)
        {
            if (path == null || root == null) return false;
            if (string.Equals(path, root, StringComparison.OrdinalIgnoreCase)) return true;
            string prefix = root == "\\" ? "\\" : root + "\\";
            return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        // Drop a path and its subtree from the per-session maps and listing cache
        // after it has been deleted.
        private void ForgetSubtree(string root)
        {
            if (root == null) return;
            foreach (var key in _createdIds.Keys)
                if (IsAtOrUnder(key, root)) _createdIds.TryRemove(key, out _);
            foreach (var key in _localEmpty.Keys)
                if (IsAtOrUnder(key, root)) _localEmpty.TryRemove(key, out _);
            foreach (var key in _dirCache.Keys)
                if (IsAtOrUnder(key, root)) _dirCache.TryRemove(key, out _);
        }

        // Re-key a path and its subtree after a rename/move: a folder rename
        // changes every descendant's path, so stale old-prefix entries would
        // point later saves at the wrong file.
        private void RekeySubtree(string oldRoot, string newRoot)
        {
            if (oldRoot == null || newRoot == null) return;
            foreach (var kv in _createdIds)
            {
                if (!IsAtOrUnder(kv.Key, oldRoot)) continue;
                if (_createdIds.TryRemove(kv.Key, out var id))
                    TrackCreatedId(string.Concat(newRoot, kv.Key.AsSpan(oldRoot.Length)), id);
            }
            foreach (var key in _localEmpty.Keys)
            {
                if (!IsAtOrUnder(key, oldRoot)) continue;
                if (_localEmpty.TryRemove(key, out _))
                    TrackLocalEmpty(string.Concat(newRoot, key.AsSpan(oldRoot.Length)));
            }
            foreach (var key in _dirCache.Keys)
                if (IsAtOrUnder(key, oldRoot)) _dirCache.TryRemove(key, out _);
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

        // The one FileInfo builder: everything but the size comes from the node.
        private static FileInfo MakeInfoCore(Node n, long size)
        {
            var info = new FileInfo();
            info.FileAttributes = n.IsFolder
                ? (uint)System.IO.FileAttributes.Directory
                : (uint)System.IO.FileAttributes.Normal;
            info.FileSize = n.IsFolder ? 0UL : (ulong)Math.Max(0, size);
            info.AllocationSize = (info.FileSize + 4095) & ~4095UL;
            ulong ft = ToFileTime(n.Modified);
            info.CreationTime = info.LastWriteTime = info.ChangeTime = ft;
            info.LastAccessTime = AccessFileTime(n);
            return info;
        }

        private static FileInfo MakeInfoFromNode(Node n) => MakeInfoCore(n, n.Size);

        // An open handle reports the staged length, which is ahead of the node's
        // size until the write-back lands.
        private static FileInfo MakeInfo(OpenFile of)
            => of.IsDir ? MakeInfoFromNode(of.Node) : MakeInfoCore(of.Node, of.CurrentSize);

        private static FileInfo MakeInfoFolder(Node folder) => MakeInfoCore(folder, 0);

        // Last-access time to report: the backend owns it; when absent, fall
        // back to the write time (not "now") so the drive never invents a read.
        private static ulong AccessFileTime(Node n)
            => ToFileTime(n.Accessed != default ? n.Accessed : n.Modified);

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

        // Whether a backend name is safe as one path component: a separator,
        // colon or ".." would address a different node (and isn't a legal name).
        private static bool IsSafeName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.Length > 255) return false;
            if (name == "." || name == "..") return false;
            if (name[name.Length - 1] == '.' || name[name.Length - 1] == ' ') return false;
            foreach (char c in name)
            {
                if (c < 0x20 || c == 0x7F) return false;
                if (c == '\\' || c == '/' || c == ':' || c == '*' || c == '?' ||
                    c == '"' || c == '<' || c == '>' || c == '|') return false;
            }
            return true;
        }

        private static Node NodeFromJson(JsonElement el, string parentPath)
        {
            if (el.ValueKind != JsonValueKind.Object) return null;
            string name = el.TryGetProperty("name", out var np) && np.ValueKind == JsonValueKind.String
                ? np.GetString() : null;
            if (!IsSafeName(name)) return null;
            string id = el.TryGetProperty("id", out var idp) ? JsonToStringId(idp) : null;
            string type = el.TryGetProperty("type", out var tp) ? tp.GetString() : "file";
            bool isFolder = string.Equals(type, "folder", StringComparison.OrdinalIgnoreCase);
            long size = el.TryGetProperty("size", out var sp) ? ParseLong(sp) : 0;
            DateTime mod = DateTime.UtcNow;
            if (el.TryGetProperty("modified", out var mp)) mod = ParseDate(mp);
            // Absent on older backends and on responses that do not carry it
            // (mkdir/upload results, trash listings). Left unset so the info
            // builders fall back to the write time.
            DateTime acc = default;
            if (el.TryGetProperty("accessedAt", out var ap)) acc = ParseDateOrDefault(ap);
            return new Node
            {
                Id = id,
                Name = name,
                IsFolder = isFolder,
                Size = size,
                Modified = mod,
                Accessed = acc,
                Path = Combine(parentPath, name),
            };
        }

        private static DateTime ParseDate(JsonElement mp)
        {
            var d = ParseDateOrDefault(mp);
            return d == default ? DateTime.UtcNow : d;
        }

        // Parse a JSON timestamp, returning default(DateTime) when missing/null/
        // unreadable, so callers can pick their own fallback instead of "now".
        private static DateTime ParseDateOrDefault(JsonElement mp)
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
            return default;
        }

        private static void Log(string msg)
        {
            try { Console.Error.WriteLine("[fs] " + msg); } catch { }
        }

    }
}
