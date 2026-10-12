using System.Text;

namespace TmaCloud.Fs
{
    /// <summary>
    /// Maps stored names to names Windows can hold and back, as Cygwin, WSL and
    /// Syncthing do: a reserved character c, or a trailing dot or space, becomes
    /// U+F000 | c in the private-use area, so the round trip is exact.
    /// </summary>
    public static class WindowsNames
    {
        private const int Offset = 0xF000;

        private static bool IsReserved(char c) =>
            c < 0x20 || c == '"' || c == '*' || c == ':' || c == '<' || c == '>' ||
            c == '?' || c == '|' || c == '\\';

        /// <summary>The name to show Windows for a stored name.</summary>
        public static string ToWindows(string name)
        {
            if (string.IsNullOrEmpty(name)) return name;
            // Windows drops trailing dots and spaces, so those are encoded too.
            int end = name.Length;
            while (end > 0 && (name[end - 1] == '.' || name[end - 1] == ' ')) end--;
            StringBuilder sb = null;
            for (int i = 0; i < name.Length; i++)
            {
                char c = name[i];
                if (!IsReserved(c) && i < end) { sb?.Append(c); continue; }
                sb ??= new StringBuilder(name, 0, i, name.Length);
                sb.Append((char)(Offset | c));
            }
            return sb?.ToString() ?? name;
        }

        /// <summary>The stored name for a name Windows passed in.</summary>
        public static string ToServer(string name)
        {
            if (string.IsNullOrEmpty(name)) return name;
            StringBuilder sb = null;
            for (int i = 0; i < name.Length; i++)
            {
                char c = name[i];
                char plain = (char)(c & 0x7F);
                // Only code points ToWindows produces; other private-use characters stay.
                bool encoded = (c & 0xFF80) == Offset && plain != 0 &&
                               (IsReserved(plain) || plain == '.' || plain == ' ');
                if (!encoded) { sb?.Append(c); continue; }
                sb ??= new StringBuilder(name, 0, i, name.Length);
                sb.Append(plain);
            }
            return sb?.ToString() ?? name;
        }
    }
}
