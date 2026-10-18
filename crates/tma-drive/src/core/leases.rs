//! Edit locks the drive holds on the server while an app here has a document
//! open, renewed in the background and given up when the document closes, so
//! others see who is editing and get it read-only instead of saving over it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use super::{Core, lock};
use crate::backend::{Backend, Lock};
use crate::{editing, paths};

/// Well inside the server's two-minute lease, so one failed renewal loses nothing.
const RENEW: Duration = Duration::from_secs(40);

pub struct Leases {
    backend: Arc<dyn Backend>,
    /// Locks held, by file id: the folder (path key) the document is in.
    held: Mutex<HashMap<String, String>>,
    /// Files the desktop app opened in a program it is watching, by id: how many
    /// such programs. Owner files coming and going never release these.
    holds: Mutex<HashMap<String, usize>>,
}

impl Leases {
    pub(super) fn new(backend: Arc<dyn Backend>) -> Arc<Self> {
        let leases = Arc::new(Self { backend, held: Mutex::new(HashMap::new()), holds: Mutex::new(HashMap::new()) });
        let weak: Weak<Self> = Arc::downgrade(&leases);
        let spawned = std::thread::Builder::new().name("cloud-drive-locks".into()).spawn(move || {
            loop {
                std::thread::sleep(RENEW);
                let Some(leases) = weak.upgrade() else { break };
                leases.renew();
            }
        });
        if let Err(err) = spawned {
            log::warn!("[drive] edit locks will not be renewed: {err}");
        }
        leases
    }

    /// The documents (id, name) in `folder` an app has open now: lock those newly
    /// opened and, with `release`, let go of those closed since. Returns the names
    /// someone else was already editing, with who.
    pub fn settle(&self, folder: &str, open: &[(String, String)], release: bool) -> Vec<(String, String)> {
        let folder = paths::key(folder);
        let mut busy = Vec::new();
        for (id, name) in open {
            if lock(&self.held).contains_key(id) {
                continue;
            }
            match self.backend.lock(id) {
                Ok(Lock::Held) => {
                    lock(&self.held).insert(id.clone(), folder.clone());
                }
                Ok(Lock::Busy(editor)) => busy.push((name.clone(), editor)),
                Err(err) => log::debug!("[drive] could not lock {name}: {err}"),
            }
        }
        if release {
            let closed: Vec<String> = lock(&self.held)
                .iter()
                .filter(|(id, dir)| **dir == folder && !open.iter().any(|(o, _)| o == *id))
                .filter(|(id, _)| !lock(&self.holds).contains_key(*id))
                .map(|(id, _)| id.clone())
                .collect();
            for id in closed {
                lock(&self.held).remove(&id);
                if let Err(err) = self.backend.unlock(&id) {
                    log::debug!("[drive] could not unlock {id}: {err}");
                }
            }
        }
        busy
    }

    /// Lock a file while a program the desktop app started for it runs. Returns who
    /// else is editing it when someone is; then nothing is held.
    pub fn hold(&self, id: &str) -> Option<String> {
        if !lock(&self.held).contains_key(id) {
            match self.backend.lock(id) {
                Ok(Lock::Held) => {
                    lock(&self.held).insert(id.to_string(), String::new());
                }
                Ok(Lock::Busy(editor)) => return Some(editor),
                Err(err) => {
                    log::debug!("[drive] could not lock {id}: {err}");
                    return None;
                }
            }
        }
        *lock(&self.holds).entry(id.to_string()).or_default() += 1;
        None
    }

    /// The program from `hold` exited: free the file once no other one has it.
    pub fn let_go(&self, id: &str) {
        {
            let mut holds = lock(&self.holds);
            match holds.get_mut(id) {
                Some(count) if *count > 1 => {
                    *count -= 1;
                    return;
                }
                Some(_) => {
                    holds.remove(id);
                }
                None => return,
            }
        }
        lock(&self.held).remove(id);
        if let Err(err) = self.backend.unlock(id) {
            log::debug!("[drive] could not unlock {id}: {err}");
        }
    }

    fn renew(&self) {
        let ids: Vec<String> = lock(&self.held).keys().cloned().collect();
        for id in ids {
            // Lost after a long outage and taken by someone else: theirs now.
            if let Ok(Lock::Busy(_)) = self.backend.lock(&id) {
                lock(&self.held).remove(&id);
            }
        }
    }
}

impl Core {
    /// An owner file came or went in `folder`: lock what an app opened there, free what it closed.
    pub(super) fn settle_edits(&self, folder: &str) {
        let Ok(Some(node)) = self.resolve(folder) else { return };
        let Ok(children) = self.children(&node) else { return };
        let names: Vec<String> = children.iter().map(|c| c.name.clone()).collect();
        let open: Vec<(String, String)> = editing::edited(&names)
            .into_iter()
            .filter_map(|name| children.iter().find(|c| c.name == name).and_then(|c| c.id.clone()).map(|id| (id, name)))
            .collect();
        for (name, editor) in self.leases.settle(folder, &open, true) {
            log::warn!("[drive] {name} is open here while {editor} is editing it; it stays read-only");
        }
    }
}

impl Drop for Leases {
    fn drop(&mut self) {
        for id in lock(&self.held).keys() {
            let _ = self.backend.unlock(id);
        }
    }
}
