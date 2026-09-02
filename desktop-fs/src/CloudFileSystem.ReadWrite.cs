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
        public override int Read(object FileNode, object FileDesc, IntPtr Buffer, ulong Offset,
            uint Length, out uint BytesTransferred)
        {
            var of = (OpenFile)FileDesc;
            BytesTransferred = 0;
            // Save-only mode: allow reading back content we're staging in THIS
            // session (so Save-As / edit flows keep working) but deny reading
            // existing cloud files off the drive.
            if (DenyRead && !of.IsNew && of.Stream == null)
                return STATUS_ACCESS_DENIED;
            lock (of.Lock)
            {
                try { EnsureStream(of); }
                catch (BridgeException ex) { Log("read download failed: " + ex.Message); return STATUS_OBJECT_NAME_NOT_FOUND; }

                long size = of.Stream.Length;
                if ((long)Offset >= size) return STATUS_END_OF_FILE;

                int toRead = (int)Math.Min((long)Length, size - (long)Offset);
                // Pooled: at WinFsp's max transfer size a fresh array per call
                // lands on the large object heap and fragments it.
                byte[] buf = ArrayPool<byte>.Shared.Rent(toRead);
                try
                {
                    of.Stream.Seek((long)Offset, SeekOrigin.Begin);
                    int read = 0;
                    while (read < toRead)
                    {
                        int r = of.Stream.Read(buf, read, toRead - read);
                        if (r <= 0) break;
                        read += r;
                    }
                    Marshal.Copy(buf, 0, Buffer, read);
                    BytesTransferred = (uint)read;
                }
                finally { ArrayPool<byte>.Shared.Return(buf); }
            }
            return STATUS_SUCCESS;
        }

        public override int Write(object FileNode, object FileDesc, IntPtr Buffer, ulong Offset,
            uint Length, bool WriteToEndOfFile, bool ConstrainedIo,
            out uint BytesTransferred, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            BytesTransferred = 0;
            lock (of.Lock)
            {
                try { EnsureStream(of); }
                catch (BridgeException ex) { Log("write stage failed: " + ex.Message); FileInfo = MakeInfo(of); return STATUS_ACCESS_DENIED; }

                long size = of.Stream.Length;
                long offset = WriteToEndOfFile ? size : (long)Offset;
                uint len = Length;
                if (ConstrainedIo)
                {
                    if (offset >= size) { FileInfo = MakeInfo(of); return STATUS_SUCCESS; }
                    if (offset + len > size) len = (uint)(size - offset);
                }

                byte[] buf = ArrayPool<byte>.Shared.Rent((int)len);
                try
                {
                    Marshal.Copy(Buffer, buf, 0, (int)len);
                    of.Stream.Seek(offset, SeekOrigin.Begin);
                    of.Stream.Write(buf, 0, (int)len);
                }
                finally { ArrayPool<byte>.Shared.Return(buf); }
                of.Dirty = true;
                of.Written = true;
                BytesTransferred = len;
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

        public override int Flush(object FileNode, object FileDesc, out FileInfo FileInfo)
        {
            var of = FileDesc as OpenFile;
            if (of == null) { FileInfo = default; return STATUS_SUCCESS; }
            lock (of.Lock)
            {
                try { of.Stream?.Flush(); } catch { }
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

        public override int GetFileInfo(object FileNode, object FileDesc, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            lock (of.Lock) { FileInfo = MakeInfo(of); }
            return STATUS_SUCCESS;
        }

        public override int SetBasicInfo(object FileNode, object FileDesc, uint FileAttributes,
            ulong CreationTime, ulong LastAccessTime, ulong LastWriteTime, ulong ChangeTime,
            out FileInfo FileInfo)
        {
            // The backend owns timestamps/attributes; accept the request (so
            // apps don't fail) but drop it and report current info. Matters most
            // for LastAccessTime: honouring Windows' write-back on close would
            // overwrite the server's value with a read it never saw.
            var of = (OpenFile)FileDesc;
            lock (of.Lock) { FileInfo = MakeInfo(of); }
            return STATUS_SUCCESS;
        }

        public override int SetFileSize(object FileNode, object FileDesc, ulong NewSize,
            bool SetAllocationSize, out FileInfo FileInfo)
        {
            var of = (OpenFile)FileDesc;
            lock (of.Lock)
            {
                if (!SetAllocationSize)
                {
                    try { EnsureStream(of); of.Stream.SetLength((long)NewSize); of.Dirty = true; }
                    catch (BridgeException ex) { Log("setsize failed: " + ex.Message); }
                }
                FileInfo = MakeInfo(of);
            }
            return STATUS_SUCCESS;
        }

    }
}
