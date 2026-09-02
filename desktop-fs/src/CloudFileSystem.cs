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
    /// <summary>
    /// WinFsp filesystem projecting the id-addressed TMA Cloud REST store as a
    /// path-addressed Windows volume. Backend I/O is delegated to the Electron
    /// main process over <see cref="Bridge"/> (which holds the session cookies):
    /// path→id resolution walks cached listings; reads lazily download to a
    /// per-handle temp file; writes stage there and upload on last-handle
    /// Cleanup, so "Save As" flows through the normal upload/replace pipeline.
    /// </summary>
    public sealed partial class CloudFileSystem : FileSystemBase, IDisposable
    {
        // NTSTATUS codes we return; shadow FileSystemBase's with explicit Int32 typing.
        private new const int STATUS_SUCCESS = 0;
        private new const int STATUS_END_OF_FILE = unchecked((int)0xC0000011);
        private new const int STATUS_ACCESS_DENIED = unchecked((int)0xC0000022);
        private new const int STATUS_OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);
        private new const int STATUS_OBJECT_PATH_NOT_FOUND = unchecked((int)0xC000003A);
        private new const int STATUS_DIRECTORY_NOT_EMPTY = unchecked((int)0xC0000101);

        // WinFsp flag bits we care about.
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
        // Serializes new-file write-back so concurrent "Save As" Cleanups
        // (placeholder + real content) can't both create a duplicate.
        private readonly object _uploadLock = new object();
        // Path -> backend id for files created this session; immune to the
        // backend's ~60s listing cache so a placeholder+content pair resolves
        // to one backend file even when a fresh list is still stale.
        private readonly ConcurrentDictionary<string, string> _createdIds =
            new ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // Full paths of 0-byte "Save As" placeholders kept local-only (never
        // materialized on the backend), so the create/verify/rename dance works
        // without an S3 object, DB row, or wasted quota.
        private readonly ConcurrentDictionary<string, byte> _localEmpty =
            new ConcurrentDictionary<string, byte>(StringComparer.OrdinalIgnoreCase);
        private readonly byte[] _defaultSecurity;

        // Security descriptor for every file/folder: only the current user (plus
        // SYSTEM and Administrators) — unlike WinFsp's Everyone-access samples,
        // which would expose one user's documents on a shared machine.
        private static byte[] BuildDefaultSecurity()
        {
            string sddl = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)";
            try
            {
                using var me = WindowsIdentity.GetCurrent();
                var user = me.User;
                if (user != null)
                    sddl = $"O:{user.Value}G:{user.Value}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{user.Value})";
            }
            catch (Exception) { /* keep the restrictive fallback */ }

            var sd = new RawSecurityDescriptor(sddl);
            var bytes = new byte[sd.BinaryLength];
            sd.GetBinaryForm(bytes, 0);
            return bytes;
        }

        // Volume size reported to Windows, refreshed from the backend quota
        // (GET /api/user/storage) on a timer since GetVolumeInfo is hot. For an
        // unlimited (S3) account the backend reports total=null; we then present
        // a fixed synthetic capacity (steady Explorer bar) with free shrinking
        // as files are added, floored so a "Save As" is never blocked at 0.
        private const long SyntheticCapacity = 1L << 50; // 1 PiB
        private const long MinFreeFloor = 1L << 30;      // 1 GiB, never block saves
        private long _totalSize = SyntheticCapacity; // placeholder until first refresh
        private long _freeSize = SyntheticCapacity;
        private System.Threading.Timer _statsTimer;
        private int _refreshingStats;
        private volatile bool _disposed;

        // "Save-only" mode: deny reading file CONTENT (browse + Save-As still
        // work), so an admin can force opening through the app. Toggled live via
        // a "mode" push.
        public volatile bool DenyRead;

        // Invoked on a "shutdown" push; Program wires this to the service Stop()
        // for a clean unmount before the process exits.
        public Action OnShutdownRequested;

        public CloudFileSystem(Bridge bridge, string volumeLabel, bool denyRead = false)
        {
            _bridge = bridge;
            _volumeLabel = volumeLabel;
            DenyRead = denyRead;
            _stagingDir = Path.Combine(Path.GetTempPath(), "tma-cloud-fs");
            Directory.CreateDirectory(_stagingDir);
            CleanStagingDir();

            _defaultSecurity = BuildDefaultSecurity();

            // Backend-driven cache invalidation (Electron forwards the SSE
            // stream): a push clears one folder or everything, so remote changes
            // surface before the listing TTL.
            _bridge.OnPush = msg =>
            {
                try
                {
                    string push = msg.TryGetProperty("push", out var pv) ? pv.GetString() : null;
                    if (push == "shutdown")
                    {
                        Log("shutdown requested by host");
                        OnShutdownRequested?.Invoke();
                        return;
                    }
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

            // Refresh the reported volume size: shortly after mount, then every 30s.
            _statsTimer = new System.Threading.Timer(RefreshStats, null, 500, 30000);
        }

        /// <summary>Fetch real quota/usage and update the cached volume size.</summary>
        private void RefreshStats(object state)
        {
            if (_disposed) return;
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
                    if (total > 0) { Volatile.Write(ref _totalSize, total); Volatile.Write(ref _freeSize, Math.Max(0, free)); }
                }
                else
                {
                    // Unlimited/unknown quota (S3): stable synthetic total, with
                    // free shrinking by usage and floored so saves aren't blocked.
                    Volatile.Write(ref _totalSize, SyntheticCapacity);
                    Volatile.Write(ref _freeSize, Math.Max(MinFreeFloor, SyntheticCapacity - used));
                }
            }
            catch { /* keep previous values */ }
            finally { System.Threading.Interlocked.Exchange(ref _refreshingStats, 0); }
        }

        public void Dispose()
        {
            _disposed = true;
            // Wait out an in-flight tick before the service disposes the bridge.
            var timer = System.Threading.Interlocked.Exchange(ref _statsTimer, null);
            if (timer != null)
            {
                using var drained = new ManualResetEvent(false);
                try
                {
                    if (timer.Dispose(drained)) drained.WaitOne(TimeSpan.FromSeconds(20));
                }
                catch (ObjectDisposedException) { /* already gone */ }
            }
            // Break the bridge -> filesystem reference so an unmount frees both.
            if (_bridge != null) _bridge.OnPush = null;
            OnShutdownRequested = null;
            _dirCache.Clear();
            _createdIds.Clear();
            _localEmpty.Clear();
            CleanStagingDir(all: true);
        }
    }
}
