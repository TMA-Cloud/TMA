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
        public override int Init(object Host)
        {
            var host = (FileSystemHost)Host;
            host.SectorSize = 4096;
            host.SectorsPerAllocationUnit = 1;
            host.MaxComponentLength = 255;
            host.VolumeCreationTime = (ulong)DateTime.UtcNow.ToFileTimeUtc();
            host.VolumeSerialNumber = (uint)(host.VolumeCreationTime / (10000UL * 1000UL));
            host.CaseSensitiveSearch = false;
            host.CasePreservedNames = true;
            host.UnicodeOnDisk = true;
            host.PersistentAcls = false;
            host.PostCleanupWhenModifiedOnly = false; // always get a final Cleanup
            host.FlushAndPurgeOnCleanup = true;
            return STATUS_SUCCESS;
        }

        public override int GetVolumeInfo(out VolumeInfo VolumeInfo)
        {
            VolumeInfo = default;
            VolumeInfo.TotalSize = (ulong)Volatile.Read(ref _totalSize);
            VolumeInfo.FreeSize = (ulong)Volatile.Read(ref _freeSize);
            VolumeInfo.SetVolumeLabel(_volumeLabel);
            return STATUS_SUCCESS;
        }

        public override int SetVolumeLabel(string VolumeLabel, out VolumeInfo VolumeInfo)
            => GetVolumeInfo(out VolumeInfo);

    }
}
