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

        // Last read time (LastAccessTime). DateTime.MinValue when the backend
        // omits it, so the write time is shown instead.
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

    // Cached directory listing with a short expiry, keyed by folder path; also
    // invalidated on writes and by the forwarded SSE stream.
    public sealed class DirCache
    {
        public List<Node> Children;
        public DateTime FetchedUtc;
        public bool IsFresh(TimeSpan ttl) => DateTime.UtcNow - FetchedUtc < ttl;
    }

    // Per-open-handle state (WinFsp's "FileDesc"). A directory handle carries
    // just its node; a file handle also owns a local staging file.
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
