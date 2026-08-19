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
    ///   TmaCloudFs.exe --pipe &lt;name&gt; [--token-stdin] [--mount T:|*]
    ///                  [--label "TMA Cloud"] [--mode saveonly] [--debug]
    ///
    /// With --token-stdin the bridge token is read from stdin (or from
    /// TMA_CLOUD_FS_TOKEN) - never argv, which any process here can read.
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
            string label = "TMA Cloud";
            bool debug = false;
            bool denyRead = false;             // "save-only" mode
            bool tokenFromStdin = false;

            for (int i = 1; i < Args.Length; i++)
            {
                switch (Args[i])
                {
                    case "--mount": mountPoint = NextArg(Args, ref i); break;
                    case "--pipe": pipeName = NextArg(Args, ref i); break;
                    case "--label": label = NextArg(Args, ref i); break;
                    case "--mode":
                        denyRead = string.Equals(NextArg(Args, ref i), "saveonly",
                            StringComparison.OrdinalIgnoreCase);
                        break;
                    case "--token-stdin": tokenFromStdin = true; break;
                    case "--debug": debug = true; break;
                }
            }

            if (string.IsNullOrEmpty(pipeName))
                throw new ArgumentException("--pipe <name> is required");

            string token = ReadToken(tokenFromStdin);

            _bridge = new Bridge(pipeName, token);
            _bridge.Connect();

            _fs = new CloudFileSystem(_bridge, label, denyRead);
            // Let a "shutdown" push from Electron stop the service cleanly, so
            // OnStop() unmounts and releases staging before the process exits
            // (instead of being force-terminated with no cleanup).
            _fs.OnShutdownRequested = () => { try { Stop(); } catch { /* already stopping */ } };
            _host = new FileSystemHost(_fs)
            {
                FileInfoTimeout = 2000,
                FileSystemName = "TMACLOUD",
                Prefix = null,
            };

            uint debugFlags = debug ? unchecked((uint)(-1)) : 0;
            Mount(mountPoint, debugFlags);

            Console.WriteLine("MOUNTED " + _host.MountPoint());
            Console.Out.Flush();
        }

        /// <summary>Value for a flag, without running off the end of argv.</summary>
        private static string NextArg(string[] args, ref int i)
        {
            if (i + 1 >= args.Length)
                throw new ArgumentException(args[i] + " requires a value");
            return args[++i];
        }

        /// <summary>
        /// The secret authenticating us to the bridge, read from stdin (only our
        /// parent holds the write end). On a command line it would be readable
        /// by every process running as this user, who could then replay it to
        /// drive the signed-in account. The env var is a manual-run fallback.
        /// </summary>
        private static string ReadToken(bool fromStdin)
        {
            string env = Environment.GetEnvironmentVariable("TMA_CLOUD_FS_TOKEN");
            if (!string.IsNullOrEmpty(env))
            {
                Environment.SetEnvironmentVariable("TMA_CLOUD_FS_TOKEN", null);
                return env;
            }
            // Opt-in: an unasked-for read would block forever against an
            // inherited console handle, which is what a manual run has.
            if (!fromStdin || !Console.IsInputRedirected) return null;
            try
            {
                string line = Console.In.ReadLine();
                if (!string.IsNullOrEmpty(line)) return line.Trim();
            }
            catch (IOException) { /* parent closed it */ }
            return null;
        }

        /// <summary>
        /// Mount at the requested point, or - for "*" - the highest free drive
        /// letter. Another process can claim a letter between the scan and the
        /// mount, so fall through to the next candidate rather than failing.
        /// </summary>
        private void Mount(string mountPoint, uint debugFlags)
        {
            if (mountPoint != "*" && !string.IsNullOrEmpty(mountPoint))
            {
                // WinFsp's Mount does not accept "*" for "next free drive
                // letter" (it throws), so only a concrete point gets here.
                if (0 > _host.Mount(mountPoint, null, false, debugFlags))
                    throw new IOException("cannot mount TMA Cloud file system at " + mountPoint);
                return;
            }

            foreach (string candidate in FreeDriveLetters())
            {
                try
                {
                    if (0 <= _host.Mount(candidate, null, false, debugFlags)) return;
                }
                catch (Exception)
                {
                    // Letter taken between the scan and the mount - keep going.
                }
            }
            throw new IOException("no free drive letter available to mount TMA Cloud");
        }

        /// <summary>Free letters, Z down to D (cloud drives use a high one).</summary>
        private static System.Collections.Generic.IEnumerable<string> FreeDriveLetters()
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
                    yield return c + ":";
        }

        protected override void OnStop()
        {
            try { _host?.Unmount(); } catch { /* not mounted */ }
            _host = null;
            try { _fs?.Dispose(); } catch { /* best effort */ }
            _fs = null;
            try { _bridge?.Dispose(); } catch { /* best effort */ }
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
            using var service = new TmaCloudService();
            Environment.ExitCode = service.Run();
        }
    }
}
