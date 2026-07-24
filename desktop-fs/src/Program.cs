using System;
using System.IO;
using Fsp;

namespace TmaCloud.Fs
{
    /// <summary>
    /// Hosts the TMA Cloud filesystem. Runs as a console child process spawned
    /// by the Electron app (Fsp.Service handles both console and service modes).
    ///
    /// Usage:
    ///   TmaCloudFs.exe --pipe &lt;name&gt; [--mount T:|*] [--label "TMA Cloud"]
    ///                  [--mode saveonly] [--debug]
    ///
    /// On success it prints "MOUNTED &lt;drive&gt;" to stdout so the parent can learn
    /// the assigned drive letter (relevant when --mount is "*").
    /// </summary>
    public sealed class TmaCloudService : Service, IDisposable
    {
        private FileSystemHost _host;
        private CloudFileSystem _fs;
        private Bridge _bridge;

        public TmaCloudService() : base("TmaCloudFs") { }

        protected override void OnStart(string[] Args)
        {
            string mountPoint = "*";           // next free drive letter by default
            string pipeName = null;
            string token = null;
            string label = "TMA Cloud";
            bool debug = false;
            bool denyRead = false;             // "save-only" mode

            for (int i = 1; i < Args.Length; i++)
            {
                switch (Args[i])
                {
                    case "--mount": mountPoint = Args[++i]; break;
                    case "--pipe": pipeName = Args[++i]; break;
                    case "--token": token = Args[++i]; break;
                    case "--label": label = Args[++i]; break;
                    case "--mode": denyRead = string.Equals(Args[++i], "saveonly", StringComparison.OrdinalIgnoreCase); break;
                    case "--debug": debug = true; break;
                }
            }

            if (string.IsNullOrEmpty(pipeName))
                throw new ArgumentException("--pipe <name> is required");

            // WinFsp's Mount does not accept "*" for "next free drive letter"
            // (it throws), so resolve a concrete free letter ourselves.
            if (mountPoint == "*" || string.IsNullOrEmpty(mountPoint))
            {
                mountPoint = PickFreeDriveLetter()
                    ?? throw new IOException("no free drive letter available to mount TMA Cloud");
            }

            _bridge = new Bridge(pipeName, token);
            _bridge.Connect();

            _fs = new CloudFileSystem(_bridge, label, denyRead);
            _host = new FileSystemHost(_fs)
            {
                FileInfoTimeout = 2000,
                FileSystemName = "TMACLOUD",
                Prefix = null,
            };

            uint debugFlags = debug ? unchecked((uint)(-1)) : 0;
            if (0 > _host.Mount(mountPoint, null, false, debugFlags))
                throw new IOException("cannot mount TMA Cloud file system at " + mountPoint);

            Console.WriteLine("MOUNTED " + _host.MountPoint());
            Console.Out.Flush();
        }

        /// <summary>
        /// Pick the highest free drive letter in D..Z (cloud drives conventionally
        /// use a high letter), avoiding A–C and anything already in use.
        /// </summary>
        private static string PickFreeDriveLetter()
        {
            var used = new System.Collections.Generic.HashSet<char>();
            foreach (var d in DriveInfo.GetDrives())
            {
                var name = d.Name;
                if (!string.IsNullOrEmpty(name))
                    used.Add(char.ToUpperInvariant(name[0]));
            }
            for (char c = 'Z'; c >= 'D'; c--)
                if (!used.Contains(c))
                    return c + ":";
            return null;
        }

        protected override void OnStop()
        {
            try { _host?.Unmount(); } catch { }
            _host = null;
            try { _fs?.Dispose(); } catch { }
            _fs = null;
            try { _bridge?.Dispose(); } catch { }
            _bridge = null;
        }

        // The service owns the mount host, filesystem, and bridge (all
        // disposable). OnStop already tears them down on the service lifecycle;
        // Dispose reuses it so the type honors IDisposable and is safe to
        // dispose more than once (each field is null-guarded).
        public void Dispose() => OnStop();
    }

    public static class Program
    {
        public static void Main(string[] args)
        {
            Environment.ExitCode = new TmaCloudService().Run();
        }
    }
}
