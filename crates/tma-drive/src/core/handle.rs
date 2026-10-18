//! Open files and folders. File contents live in a local staging file from the
//! first read or write; a changed file uploads when its last handle cleans up.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;

use super::{Core, FsError, FsResult, Node, lock, scratch};
use crate::paths;

#[derive(Debug)]
pub struct State {
    pub node: Node,
    pub(super) local: Option<PathBuf>,
    file: Option<File>,
    dirty: bool,
    /// Created here and not yet on the server.
    pub(super) is_new: bool,
    /// Received at least one write (a bare create is only a placeholder).
    written: bool,
    deleted: bool,
    pub(super) parent: Option<Node>,
    /// A scratch file (see `scratch.rs`): its contents stay here and never upload.
    scratch: bool,
}

/// One open file or folder.
#[derive(Debug)]
pub struct Handle {
    pub is_dir: bool,
    pub state: Mutex<State>,
}

impl Handle {
    fn new(node: Node, parent: Option<Node>, is_new: bool) -> Self {
        Self {
            is_dir: node.is_folder,
            state: Mutex::new(State {
                node,
                local: None,
                file: None,
                dirty: is_new,
                is_new,
                written: false,
                deleted: false,
                parent,
                scratch: false,
            }),
        }
    }

    pub fn node(&self) -> Node {
        lock(&self.state).node.clone()
    }

    /// The current size: the staged file's while open, else the listing's.
    pub fn size(&self) -> u64 {
        let state = lock(&self.state);
        state.file.as_ref().and_then(|f| f.metadata().ok()).map(|m| m.len()).unwrap_or(state.node.size)
    }
}

fn io(err: std::io::Error) -> FsError {
    FsError::Io(err.to_string())
}

impl Core {
    pub fn open(&self, path: &str) -> FsResult<Handle> {
        if let Some(s) = self.scratch(&paths::normalize(path)) {
            let mut node = self.resolve(path)?.ok_or(FsError::NotFound)?;
            node.id = s.backup_of.clone();
            let handle = Handle::new(node, None, s.backup_of.is_none());
            {
                let mut state = lock(&handle.state);
                state.local = s.staging;
                state.scratch = true;
                state.dirty = false;
            }
            return Ok(handle);
        }
        let node = self.resolve(path)?.ok_or(FsError::NotFound)?;
        // A local empty placeholder opens as a new file: writing to it uploads it.
        if !node.is_folder && node.id.is_none() {
            let parent = paths::parent(&node.path).and_then(|p| self.resolve(&p).ok().flatten());
            return Ok(Handle::new(node, parent, true));
        }
        if !node.is_folder {
            self.remember_opened(&node.path, node.version);
        }
        Ok(Handle::new(node, None, false))
    }

    pub fn create(&self, path: &str, is_dir: bool) -> FsResult<Handle> {
        let path = paths::normalize(path);
        let parent_path = paths::parent(&path).ok_or(FsError::AccessDenied)?;
        let name = paths::leaf(&path).to_string();
        let parent = self.resolve(&parent_path)?.filter(|p| p.is_folder).ok_or(FsError::PathNotFound)?;
        if !paths::is_safe_name(&name) {
            return Err(FsError::AccessDenied);
        }
        if is_dir {
            let _guard = self.path_lock(&path);
            let id = self.folder_for(&path, parent.id.as_deref(), &name)?;
            self.track_created(&path, &id);
            self.invalidate(&parent_path);
            let node = Node {
                id: Some(id),
                name,
                is_folder: true,
                size: 0,
                modified: Utc::now(),
                accessed: None,
                path,
                version: 0,
                editor: None,
            };
            return Ok(Handle::new(node, None, false));
        }
        let local = self.new_staging_file();
        let file = OpenOptions::new().read(true).write(true).create_new(true).open(&local).map_err(io)?;
        let node = Node {
            id: None,
            name,
            is_folder: false,
            size: 0,
            modified: Utc::now(),
            accessed: None,
            path,
            version: 0,
            editor: None,
        };
        let scratch = scratch::is_scratch_name(&node.path);
        if scratch {
            self.add_scratch(&node.path, local.clone());
        }
        let handle = Handle::new(node, Some(parent), true);
        {
            let mut state = lock(&handle.state);
            state.local = Some(local);
            state.file = Some(file);
            state.scratch = scratch;
        }
        Ok(handle)
    }

    /// Download (or create) the staging file on first use.
    fn ensure_file(&self, state: &mut State) -> FsResult<()> {
        if state.file.is_some() {
            return Ok(());
        }
        if state.scratch {
            // Shared by every handle on the scratch file, and kept after they close.
            let local = match state.local.clone() {
                Some(local) => local,
                None => {
                    let local = self.new_staging_file();
                    match &state.node.id {
                        Some(id) => self.backend.download(id, &local).map_err(FsError::Io)?,
                        None => drop(File::create(&local).map_err(io)?),
                    }
                    self.keep_scratch(&state.node.path, local.clone());
                    local
                }
            };
            let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&local);
            state.file = Some(file.map_err(io)?);
            state.local = Some(local);
            return Ok(());
        }
        let local = state.local.clone().unwrap_or_else(|| self.new_staging_file());
        match &state.node.id {
            Some(id) => self.backend.download(id, &local).map_err(|e| {
                log::warn!("download failed: {e}");
                FsError::NotFound
            })?,
            None => {
                File::create(&local).map_err(io)?;
            }
        }
        let file = OpenOptions::new().read(true).write(true).open(&local).map_err(io)?;
        state.local = Some(local);
        state.file = Some(file);
        Ok(())
    }

    /// Truncate for an app that replaces a file's contents.
    pub fn overwrite(&self, handle: &Handle) -> FsResult<()> {
        let mut state = lock(&handle.state);
        match &state.file {
            Some(file) => file.set_len(0).map_err(io)?,
            None => {
                let local = state.local.clone().unwrap_or_else(|| self.new_staging_file());
                let file =
                    OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&local).map_err(io)?;
                if state.scratch {
                    self.keep_scratch(&state.node.path, local.clone());
                }
                state.local = Some(local);
                state.file = Some(file);
            }
        }
        state.dirty = true;
        state.node.modified = Utc::now();
        state.node.accessed = None;
        Ok(())
    }

    pub fn read(&self, handle: &Handle, offset: u64, buf: &mut [u8]) -> FsResult<usize> {
        let mut state = lock(&handle.state);
        // Save-only drives refuse to open what is already in the cloud, except what TMA Cloud
        // opened or copied; new files stay readable.
        if !state.is_new && state.file.is_none() && !self.may_read(&state.node.path) {
            return Err(FsError::AccessDenied);
        }
        self.ensure_file(&mut state)?;
        let Some(file) = state.file.as_mut() else { return Err(FsError::Io("no staging file".into())) };
        let size = file.metadata().map_err(io)?.len();
        if offset >= size {
            return Err(FsError::EndOfFile);
        }
        file.seek(SeekFrom::Start(offset)).map_err(io)?;
        let want = buf.len().min((size - offset) as usize);
        let mut read = 0;
        while read < want {
            match file.read(&mut buf[read..want]).map_err(io)? {
                0 => break,
                n => read += n,
            }
        }
        Ok(read)
    }

    /// Write at `offset` (or the end); `constrained` writes never grow the file.
    pub fn write(&self, handle: &Handle, offset: u64, data: &[u8], to_end: bool, constrained: bool) -> FsResult<usize> {
        let mut state = lock(&handle.state);
        // Someone else is editing it: read-only here until they close it.
        if state.node.editor.is_some() && !state.is_new {
            return Err(FsError::AccessDenied);
        }
        self.ensure_file(&mut state).map_err(|_| FsError::AccessDenied)?;
        let Some(file) = state.file.as_mut() else { return Err(FsError::Io("no staging file".into())) };
        let size = file.metadata().map_err(io)?.len();
        let offset = if to_end { size } else { offset };
        let mut len = data.len();
        if constrained {
            if offset >= size {
                return Ok(0);
            }
            len = len.min((size - offset) as usize);
        }
        file.seek(SeekFrom::Start(offset)).map_err(io)?;
        file.write_all(&data[..len]).map_err(io)?;
        state.dirty = true;
        state.written = true;
        Ok(len)
    }

    pub fn set_size(&self, handle: &Handle, size: u64) -> FsResult<()> {
        let mut state = lock(&handle.state);
        self.ensure_file(&mut state)?;
        if let Some(file) = &state.file {
            file.set_len(size).map_err(io)?;
        }
        state.dirty = true;
        Ok(())
    }

    pub fn can_delete(&self, handle: &Handle) -> FsResult<()> {
        let node = handle.node();
        if handle.is_dir && node.id.is_none() {
            return Err(FsError::AccessDenied);
        }
        if handle.is_dir && self.children(&node).map(|c| !c.is_empty()).unwrap_or(false) {
            return Err(FsError::NotEmpty);
        }
        Ok(())
    }

    /// The last handle closed: delete if asked, else upload changes.
    pub fn cleanup(&self, handle: &Handle, delete: bool) {
        let mut state = lock(&handle.state);
        if state.scratch {
            if delete {
                state.deleted = true;
                self.delete_scratch(&state.node.path);
            } else if let (Some(file), Some(local)) = (&state.file, &state.local) {
                let _ = file.sync_all();
                self.keep_scratch(&state.node.path, local.clone());
            }
            state.dirty = false;
            return;
        }
        if delete {
            if let Some(id) = &state.node.id
                && let Err(err) = self.backend.delete(id)
            {
                log::warn!("delete failed: {err}");
            }
            state.deleted = true;
            let path = state.node.path.clone();
            self.forget_subtree(&path);
            self.invalidate(&paths::parent(&path).unwrap_or_else(|| paths::ROOT.into()));
            return;
        }
        if !state.dirty || state.deleted {
            return;
        }
        if let Some(file) = state.file.take() {
            let _ = file.sync_all();
        }
        let staged = state.local.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
        let path = state.node.path.clone();
        if state.is_new && !state.written && staged == 0 {
            // Apps create an empty file and then write the real one; never upload the empty one.
            self.track_empty(&path);
        } else {
            match self.upload_back(&mut state) {
                Ok(()) => self.untrack_empty(&path),
                Err(err) => log::warn!("upload failed for {path}: {err}"),
            }
        }
        state.dirty = false;
    }

    pub fn close(&self, handle: &Handle) {
        let mut state = lock(&handle.state);
        state.file = None;
        if state.scratch {
            return;
        }
        if let Some(local) = state.local.take() {
            let _ = std::fs::remove_file(local);
        }
    }

    /// Rename or move; an item already at the destination is replaced (moved to the trash).
    pub fn rename(&self, from: &str, to: &str) -> FsResult<()> {
        let (from, to) = (paths::normalize(from), paths::normalize(to));
        if self.scratch(&from).is_some() {
            return self.rename_scratch(&from, &to);
        }
        let node = self.resolve(&from)?.ok_or(FsError::NotFound)?;
        if !node.is_folder
            && let Some(id) = node.id.as_deref()
            && scratch::is_scratch_name(&to)
            && !scratch::is_scratch_name(&from)
        {
            // An editor's save backup: see `scratch.rs`.
            self.stash_backup(&node, id, &to);
            return Ok(());
        }
        let old_parent = paths::parent(&from).unwrap_or_else(|| paths::ROOT.into());
        let new_parent = paths::parent(&to).ok_or(FsError::AccessDenied)?;
        let new_name = paths::leaf(&to).to_string();
        let Some(id) = node.id.clone() else {
            // A local placeholder only moves locally.
            self.untrack_empty(&from);
            self.untrack_empty(&to);
            self.track_empty(&to);
            self.invalidate(&old_parent);
            self.invalidate(&new_parent);
            return Ok(());
        };
        if !paths::is_safe_name(&new_name) {
            return Err(FsError::AccessDenied);
        }
        self.untrack_empty(&to);
        let dest_parent = self.resolve(&new_parent)?;
        let dest_parent_id = dest_parent.as_ref().and_then(|p| p.id.clone());
        let conflict = match self.created_id(&to) {
            Some(cid) if cid != id => Some(cid),
            Some(_) => None,
            None => self
                .find_child(dest_parent_id.as_deref(), &new_name, node.is_folder)?
                .map(|e| e.id)
                .filter(|cid| *cid != id),
        };
        if let Some(conflict) = conflict {
            if let Err(err) = self.backend.delete(&conflict) {
                log::warn!("rename: could not replace the existing item: {err}");
            }
            lock(&self.created).remove(&paths::key(&to));
        }
        let fail = |err: String| {
            log::warn!("rename failed: {err}");
            FsError::AccessDenied
        };
        if paths::key(&old_parent) != paths::key(&new_parent) {
            if !dest_parent.as_ref().is_some_and(|p| p.is_folder) {
                return Err(FsError::PathNotFound);
            }
            self.backend.move_to(&id, dest_parent_id.as_deref()).map_err(fail)?;
            self.invalidate(&new_parent);
        }
        if paths::leaf(&from) != new_name {
            self.backend.rename(&id, &self.to_server_name(&new_name)).map_err(fail)?;
        }
        self.rekey_subtree(&from, &to);
        self.track_created(&to, &id);
        self.invalidate(&old_parent);
        self.invalidate(&new_parent);
        Ok(())
    }
}
