//! What the account holds, found by walking it as the drive would list it.

use tma_client::Client;
use tma_drive::{Backend, ClientBackend};

#[derive(Clone)]
pub struct File {
    pub id: String,
    pub folder: Option<String>,
    pub name: String,
}

pub struct Corpus {
    pub folders: Vec<String>,
    pub files: Vec<File>,
}

impl Corpus {
    /// Every live folder and file, listed breadth first from the root.
    pub fn walk(client: &Client) -> Result<Self, String> {
        let backend = ClientBackend::new(client.clone());
        let mut corpus = Corpus { folders: Vec::new(), files: Vec::new() };
        let mut queue: Vec<Option<String>> = vec![None];
        while let Some(folder) = queue.pop() {
            for entry in backend.list(folder.as_deref())? {
                if entry.is_folder {
                    corpus.folders.push(entry.id.clone());
                    queue.push(Some(entry.id));
                } else {
                    corpus.files.push(File { id: entry.id, folder: folder.clone(), name: entry.name });
                }
            }
        }
        if corpus.files.is_empty() {
            return Err("the load-test account holds no files: run seed first".into());
        }
        Ok(corpus)
    }

    /// The folder holding the most files directly, for timing a large listing.
    pub fn fullest_folder(&self) -> Option<String> {
        let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for file in &self.files {
            if let Some(folder) = &file.folder {
                *counts.entry(folder.as_str()).or_default() += 1;
            }
        }
        counts.into_iter().max_by_key(|(_, n)| *n).map(|(id, _)| id.to_string())
    }
}
