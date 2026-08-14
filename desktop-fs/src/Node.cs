using System;
using System.Collections.Generic;

namespace TmaCloud.Fs
{
    /// <summary>
    /// A file or folder in the cloud, addressed by the backend's opaque string
    /// id. The root folder is represented by <see cref="Id"/> == null.
    /// </summary>
    public sealed class Node
    {
        public string Id;          // backend id; null == root
        public string Name;        // final path component
        public bool IsFolder;
        public long Size;
        public DateTime Modified;  // UTC; DateTime.MinValue if unknown
        public string Path;        // normalized full path, root == "\"

        // Last read time, reported to Windows as LastAccessTime. Left at
        // DateTime.MinValue when the backend did not supply one — an older
        // server, or a response that omits the field — and the write time is
        // used in its place, which is what a filesystem shows for something
        // that has been written but never read since.
        public DateTime Accessed;

        public static Node Root() => new Node
        {
            Id = null,
            Name = "",
            IsFolder = true,
            Size = 0,
            Modified = DateTime.UtcNow,
            Path = "\\",
        };
    }

    /// <summary>
    /// Cached directory listing with an expiry, keyed by folder path. Kept short
    /// so remote changes surface quickly; also invalidated explicitly on writes
    /// and (later) by the SSE event stream forwarded through the bridge.
    /// </summary>
    public sealed class DirCache
    {
        public List<Node> Children;
        public DateTime FetchedUtc;
        public bool IsFresh(TimeSpan ttl) => DateTime.UtcNow - FetchedUtc < ttl;
    }

    /// <summary>
    /// Per-open-handle state. WinFsp hands this back to us as the "FileDesc".
    /// A directory handle carries just its node; a file handle additionally
    /// owns a local staging file used for read caching and write-back.
    /// </summary>
    public sealed class OpenFile
    {
        public Node Node;
        public bool IsDir;

        // --- file staging (null/unused for directories) ---
        public string LocalPath;             // temp staging file on disk
        public System.IO.FileStream Stream;  // open handle to LocalPath
        public bool Dirty;                   // modified; needs upload on cleanup
        public bool IsNew;                   // created here; upload as new file
        public bool Written;                 // received at least one Write (vs. a bare placeholder)
        public bool Deleted;                 // delete-on-close requested
        public Node Parent;                  // upload target for new files
        public string NewName;               // name for a newly created file
        public readonly object Lock = new object();

        public long CurrentSize
        {
            get
            {
                if (Stream != null)
                {
                    try { return Stream.Length; } catch { /* fall through */ }
                }
                return Node?.Size ?? 0;
            }
        }
    }
}
