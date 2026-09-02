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
                var dirInfo = MakeInfoFolder(folder);
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

    }
}
