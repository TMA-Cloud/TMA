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
        public override int CanDelete(object FileNode, object FileDesc, string FileName)
        {
            var of = (OpenFile)FileDesc;
            if (of.IsDir && of.Node.Id == null) return STATUS_ACCESS_DENIED; // root
            if (of.IsDir)
            {
                // ChildrenOf, not ListDir: a local-only placeholder inside the
                // folder is visible on the drive, so deleting the folder out
                // from under it has to be refused the same way.
                try { if (ChildrenOf(of.Node).Count > 0) return STATUS_DIRECTORY_NOT_EMPTY; }
                catch (BridgeException) { /* allow; backend will enforce */ }
            }
            return STATUS_SUCCESS;
        }

        public override int Rename(object FileNode, object FileDesc, string FileName,
            string NewFileName, bool ReplaceIfExists)
        {
            Node node;
            try { node = Resolve(FileName); }
            catch (BridgeException) { return STATUS_OBJECT_PATH_NOT_FOUND; }
            if (node == null) return STATUS_OBJECT_NAME_NOT_FOUND;

            string oldParent = ParentPath(FileName);
            string newParent = ParentPath(NewFileName);
            string newName = LeafName(NewFileName);

            // Source is a local-only empty placeholder (never uploaded): just
            // move the local entry, no backend operation.
            if (node.Id == null)
            {
                _localEmpty.TryRemove(FileName, out _);
                _localEmpty.TryRemove(NewFileName, out _);
                TrackLocalEmpty(NewFileName);
                Invalidate(oldParent);
                Invalidate(newParent);
                return STATUS_SUCCESS;
            }

            if (!IsSafeName(newName)) return STATUS_ACCESS_DENIED;

            try
            {
                // If a local-only placeholder occupies the destination name, just
                // forget it — it was never on the backend, so the rename replaces
                // it with a single real file (no upload, no delete, no garbage).
                _localEmpty.TryRemove(NewFileName, out _);

                // Honor ReplaceIfExists for a real destination file: remove
                // whatever already occupies the target name so the rename yields
                // a single file.
                Node newParentNode = Resolve(newParent);
                string newParentId = newParentNode?.Id;

                string conflictId = null;
                if (_createdIds.TryGetValue(NewFileName, out var cId) && cId != node.Id)
                {
                    conflictId = cId;
                }
                else
                {
                    var destExisting = FindFileByName(newParentId, newName);
                    if (destExisting != null && destExisting.Id != node.Id) conflictId = destExisting.Id;
                }
                if (conflictId != null)
                {
                    try { DeleteId(conflictId); }
                    catch (BridgeException ex) { Log("rename: delete conflict failed: " + ex.Message); }
                    _createdIds.TryRemove(NewFileName, out _);
                }

                if (!string.Equals(oldParent, newParent, StringComparison.OrdinalIgnoreCase))
                {
                    if (newParentNode == null || !newParentNode.IsFolder) return STATUS_OBJECT_PATH_NOT_FOUND;
                    _bridge.Call("move", w =>
                    {
                        w.WriteStartArray("ids");
                        w.WriteStringValue(node.Id);
                        w.WriteEndArray();
                        if (newParentId != null) w.WriteString("parentId", newParentId);
                    });
                    Invalidate(newParent);
                }
                if (!string.Equals(LeafName(FileName), newName, StringComparison.Ordinal))
                {
                    _bridge.Call("rename", w =>
                    {
                        w.WriteString("id", node.Id);
                        w.WriteString("name", newName);
                    });
                }
                // Whole subtree, not just this path: a folder rename moves its
                // descendants, and stale prefixes misdirect later saves.
                RekeySubtree(FileName, NewFileName);
                TrackCreatedId(NewFileName, node.Id);          // track the file at its new path
                Invalidate(oldParent);
                Invalidate(newParent);
                return STATUS_SUCCESS;
            }
            catch (BridgeException ex) { Log("rename failed: " + ex.Message); return STATUS_ACCESS_DENIED; }
        }

        public override void Cleanup(object FileNode, object FileDesc, string FileName, uint Flags)
        {
            var of = FileDesc as OpenFile;
            if (of == null) return;
            lock (of.Lock)
            {
                if ((Flags & CLEANUP_DELETE) != 0)
                {
                    try
                    {
                        // A local-only placeholder isn't on the backend — just
                        // forget it; only real files need a backend delete.
                        if (of.Node.Id != null) DeleteId(of.Node.Id);
                    }
                    catch (BridgeException ex) { Log("delete failed: " + ex.Message); }
                    of.Deleted = true;
                    // Deleting a folder takes its descendants too; leaving them
                    // mapped would resurrect ghosts and point uploads at dead ids.
                    ForgetSubtree(of.Node.Path);
                    Invalidate(ParentPath(of.Node.Path) ?? "\\");
                    return;
                }

                if (of.Dirty && !of.Deleted)
                {
                    // Release our exclusive handle before uploading: the bridge
                    // (another process) must open the temp file to stream it, and
                    // Cleanup is the last-handle signal so no Read/Write follows.
                    try { of.Stream?.Flush(); of.Stream?.Dispose(); } catch { }
                    of.Stream = null;

                    long staged = 0;
                    try { staged = new System.IO.FileInfo(of.LocalPath).Length; } catch { /* ignore */ }

                    if (of.IsNew && !of.Written && staged == 0)
                    {
                        // Empty, never-written new file: keep it as a local-only
                        // placeholder rather than creating a 0-byte backend file.
                        TrackLocalEmpty(of.Node.Path);
                    }
                    else
                    {
                        try { UploadBack(of); _localEmpty.TryRemove(of.Node.Path, out _); }
                        catch (BridgeException ex) { Log("upload failed: " + ex.Message); }
                    }
                    of.Dirty = false;
                }
            }
        }

        public override void Close(object FileNode, object FileDesc)
        {
            var of = FileDesc as OpenFile;
            if (of == null) return;
            lock (of.Lock)
            {
                try { of.Stream?.Dispose(); } catch { }
                of.Stream = null;
                if (of.LocalPath != null)
                {
                    try { File.Delete(of.LocalPath); } catch { }
                    of.LocalPath = null;
                }
            }
        }

    }
}
