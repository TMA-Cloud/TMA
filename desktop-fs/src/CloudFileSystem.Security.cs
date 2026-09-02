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
        public override int GetSecurity(object FileNode, object FileDesc, ref byte[] SecurityDescriptor)
        {
            SecurityDescriptor = _defaultSecurity;
            return STATUS_SUCCESS;
        }

        public override int SetSecurity(object FileNode, object FileDesc,
            AccessControlSections Sections, byte[] SecurityDescriptor)
            => STATUS_SUCCESS;

    }
}
