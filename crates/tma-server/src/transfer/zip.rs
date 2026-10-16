//! A streaming ZIP writer: entries are written as they are read from the
//! bucket, sizes follow in data descriptors, ZIP64 records appear only when an
//! archive outgrows the classic limits, and already-compressed kinds are stored.

use std::io::Write;

use axum::http::{HeaderValue, header};
use axum::response::Response;
use bytes::{BufMut, Bytes, BytesMut};
use chrono::{DateTime, Datelike, Timelike, Utc};
use flate2::Compression;
use flate2::write::DeflateEncoder;
use futures::{Stream, StreamExt};

use crate::crypto::Decryptor;
use crate::error::ApiError;
use crate::models::files::archive::ArchiveEntry;
use crate::state::AppState;

const FLAGS: u16 = 0x0008 | 0x0800; // data descriptor + UTF-8 names
const U32_MAX: u64 = 0xFFFF_FFFF;

struct CdEntry {
    name: Vec<u8>,
    method: u16,
    time: u16,
    date: u16,
    crc: u32,
    compressed: u64,
    uncompressed: u64,
    offset: u64,
    is_dir: bool,
}

/// The byte layout of an archive; the caller streams entry data between headers.
#[derive(Default)]
pub struct ZipWriter {
    offset: u64,
    entries: Vec<CdEntry>,
}

fn dos_time(at: DateTime<Utc>) -> (u16, u16) {
    let year = at.year().clamp(1980, 2107) as u16;
    let date = ((year - 1980) << 9) | ((at.month() as u16) << 5) | at.day() as u16;
    let time = ((at.hour() as u16) << 11) | ((at.minute() as u16) << 5) | (at.second() as u16 / 2);
    (time, date)
}

impl ZipWriter {
    /// The local header for an entry; `name` ends with "/" for a directory.
    pub fn begin(&mut self, name: &str, method: u16, modified: DateTime<Utc>) -> Bytes {
        let (time, date) = dos_time(modified);
        let name_bytes = name.as_bytes().to_vec();
        let mut b = BytesMut::with_capacity(30 + name_bytes.len());
        b.put_u32_le(0x0403_4b50);
        b.put_u16_le(45);
        b.put_u16_le(FLAGS);
        b.put_u16_le(method);
        b.put_u16_le(time);
        b.put_u16_le(date);
        b.put_u32_le(0);
        b.put_u32_le(0);
        b.put_u32_le(0);
        b.put_u16_le(name_bytes.len() as u16);
        b.put_u16_le(0);
        b.put_slice(&name_bytes);
        self.entries.push(CdEntry {
            name: name_bytes,
            method,
            time,
            date,
            crc: 0,
            compressed: 0,
            uncompressed: 0,
            offset: self.offset,
            is_dir: name.ends_with('/'),
        });
        self.offset += b.len() as u64;
        b.freeze()
    }

    /// Count bytes of entry data the caller wrote.
    pub fn wrote(&mut self, n: usize) {
        self.offset += n as u64;
    }

    /// The data descriptor closing the current entry.
    pub fn end(&mut self, crc: u32, compressed: u64, uncompressed: u64) -> Bytes {
        let zip64 = compressed > U32_MAX || uncompressed > U32_MAX;
        if let Some(e) = self.entries.last_mut() {
            e.crc = crc;
            e.compressed = compressed;
            e.uncompressed = uncompressed;
        }
        let mut b = BytesMut::with_capacity(24);
        b.put_u32_le(0x0807_4b50);
        b.put_u32_le(crc);
        if zip64 {
            b.put_u64_le(compressed);
            b.put_u64_le(uncompressed);
        } else {
            b.put_u32_le(compressed as u32);
            b.put_u32_le(uncompressed as u32);
        }
        self.offset += b.len() as u64;
        b.freeze()
    }

    /// The central directory and end records.
    pub fn finish(self) -> Bytes {
        let cd_start = self.offset;
        let mut b = BytesMut::new();
        for e in &self.entries {
            let mut extra = BytesMut::new();
            if e.uncompressed > U32_MAX || e.compressed > U32_MAX || e.offset > U32_MAX {
                let mut fields = BytesMut::new();
                if e.uncompressed > U32_MAX {
                    fields.put_u64_le(e.uncompressed);
                }
                if e.compressed > U32_MAX {
                    fields.put_u64_le(e.compressed);
                }
                if e.offset > U32_MAX {
                    fields.put_u64_le(e.offset);
                }
                extra.put_u16_le(0x0001);
                extra.put_u16_le(fields.len() as u16);
                extra.put_slice(&fields);
            }
            b.put_u32_le(0x0201_4b50);
            b.put_u16_le((3 << 8) | 45);
            b.put_u16_le(45);
            b.put_u16_le(FLAGS);
            b.put_u16_le(e.method);
            b.put_u16_le(e.time);
            b.put_u16_le(e.date);
            b.put_u32_le(e.crc);
            b.put_u32_le(e.compressed.min(U32_MAX) as u32);
            b.put_u32_le(e.uncompressed.min(U32_MAX) as u32);
            b.put_u16_le(e.name.len() as u16);
            b.put_u16_le(extra.len() as u16);
            b.put_u16_le(0);
            b.put_u16_le(0);
            b.put_u16_le(0);
            // Unix mode in the high half (0755 dir / 0644 file), MS-DOS directory bit in the low.
            let attrs: u32 = if e.is_dir { (0o40755 << 16) | 0x10 } else { 0o100644 << 16 };
            b.put_u32_le(attrs);
            b.put_u32_le(e.offset.min(U32_MAX) as u32);
            b.put_slice(&e.name);
            b.put_slice(&extra);
        }
        let cd_size = b.len() as u64;
        let count = self.entries.len() as u64;
        if count > 0xFFFF || cd_size > U32_MAX || cd_start > U32_MAX {
            let eocd64 = cd_start + cd_size;
            b.put_u32_le(0x0606_4b50);
            b.put_u64_le(44);
            b.put_u16_le(45);
            b.put_u16_le(45);
            b.put_u32_le(0);
            b.put_u32_le(0);
            b.put_u64_le(count);
            b.put_u64_le(count);
            b.put_u64_le(cd_size);
            b.put_u64_le(cd_start);
            b.put_u32_le(0x0706_4b50);
            b.put_u32_le(0);
            b.put_u64_le(eocd64);
            b.put_u32_le(1);
        }
        b.put_u32_le(0x0605_4b50);
        b.put_u16_le(0);
        b.put_u16_le(0);
        b.put_u16_le(count.min(0xFFFF) as u16);
        b.put_u16_le(count.min(0xFFFF) as u16);
        b.put_u32_le(cd_size.min(U32_MAX) as u32);
        b.put_u32_le(cd_start.min(U32_MAX) as u32);
        b.put_u16_le(0);
        b.freeze()
    }
}

/// Stream a ZIP of `entries`, calling `on_file` for each stored file added.
pub fn response<S, F>(state: &AppState, archive_name: &str, entries: S, on_file: F) -> Result<Response, ApiError>
where
    S: Stream<Item = anyhow::Result<ArchiveEntry>> + Send + 'static,
    F: Fn(&ArchiveEntry) + Send + 'static,
{
    let state = state.clone();
    let body = async_stream::try_stream! {
        let mut zip = ZipWriter::default();
        let mut entries = Box::pin(entries);
        while let Some(entry) = entries.next().await {
            let entry = entry?;
            // Stored names may hold ":" or "?", which Windows cannot extract.
            let path: Vec<String> = entry.archive_path.split('/').map(tma_core::names::portable_name).collect();
            let name = path.join("/");
            let modified = entry.modified;
            if entry.item_type == "folder" {
                yield zip.begin(&format!("{name}/"), 0, modified);
                yield zip.end(0, 0, 0);
                continue;
            }
            let Some(key) = entry.path.clone().filter(|k| super::download::is_valid_key(k)) else { continue };
            on_file(&entry);
            let kind = tma_core::file_kind(&entry.archive_path, entry.mime_type.as_deref());
            let deflate = !kind.is_precompressed();
            let ikm = state.keyring.resolve_ikm(entry.dek_wrapped.as_deref(), entry.dek_kek_version)?;
            yield zip.begin(&name, if deflate { 8 } else { 0 }, modified);
            let mut source = state.storage.get(&key, None).await?;
            let mut decryptor = Some(Decryptor::new(ikm));
            let mut crc = crc32fast::Hasher::new();
            let mut encoder = deflate.then(|| DeflateEncoder::new(Vec::new(), Compression::fast()));
            let (mut raw, mut written) = (0u64, 0u64);
            loop {
                let next: Option<anyhow::Result<Bytes>> = source.next().await;
                let done = next.is_none();
                let plain: anyhow::Result<Vec<Bytes>> = match (next, decryptor.as_mut()) {
                    (Some(chunk), Some(d)) => chunk.and_then(|c| d.push(&c)),
                    (None, Some(_)) => decryptor.take().map(|d| d.finish().map(|last| vec![last])).unwrap_or_else(|| Ok(Vec::new())),
                    (_, None) => Err(anyhow::anyhow!("decryptor finished")),
                };
                let plain = plain?;
                for part in plain {
                    raw += part.len() as u64;
                    crc.update(&part);
                    let out = match encoder.as_mut() {
                        Some(enc) => {
                            enc.write_all(&part)?;
                            Bytes::from(std::mem::take(enc.get_mut()))
                        }
                        None => part,
                    };
                    if !out.is_empty() {
                        written += out.len() as u64;
                        zip.wrote(out.len());
                        yield out;
                    }
                }
                if done {
                    break;
                }
            }
            if let Some(enc) = encoder.take() {
                let tail = Bytes::from(enc.finish()?);
                written += tail.len() as u64;
                zip.wrote(tail.len());
                yield tail;
            }
            yield zip.end(crc.finalize(), written, raw);
        }
        yield zip.finish();
    };
    let mut builder = Response::builder().header(header::CONTENT_TYPE, "application/zip");
    if let Ok(value) =
        HeaderValue::from_str(&crate::util::content_disposition("attachment", &format!("{archive_name}.zip")))
    {
        builder = builder.header(header::CONTENT_DISPOSITION, value);
    }
    builder.body(super::download::stream_body(body)).map_err(ApiError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_archive_is_valid() {
        let zip = ZipWriter::default().finish();
        assert_eq!(zip.len(), 22);
        assert_eq!(&zip[..4], &[0x50, 0x4b, 0x05, 0x06]);
    }

    #[test]
    fn single_stored_entry_layout() {
        let mut zip = ZipWriter::default();
        let header = zip.begin("a.txt", 0, Utc::now());
        assert_eq!(header.len(), 30 + 5);
        zip.wrote(3);
        let descriptor = zip.end(crc32fast::hash(b"abc"), 3, 3);
        assert_eq!(descriptor.len(), 16);
        let tail = zip.finish();
        assert!(tail.len() > 22);
    }
}
