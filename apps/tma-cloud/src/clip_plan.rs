//! Pure clipboard logic: file paths copied as text, pasted image names and
//! the list of "virtual" files (Outlook attachments, zip contents) that
//! Windows describes in a FileGroupDescriptorW block.

use std::path::{Component, Path, PathBuf};

/// Absolute paths, one per line, as "Copy as path" in Explorer writes them.
pub fn paths_in_text(text: &str) -> Vec<PathBuf> {
    text.lines()
        .map(|l| l.trim().trim_matches('"').trim_matches('\''))
        .filter(|l| {
            let b = l.as_bytes();
            (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
                || l.starts_with("\\\\")
                || (cfg!(not(windows)) && l.starts_with('/'))
        })
        .take(100)
        .map(PathBuf::from)
        .collect()
}

/// One entry of a FileGroupDescriptorW: a relative path inside the copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Described {
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: Option<u64>,
}

const DESCRIPTOR: usize = 592;
const NAME_AT: usize = 72;
const FD_ATTRIBUTES: u32 = 0x4;
const FD_FILESIZE: u32 = 0x40;
const DIRECTORY: u32 = 0x10;

fn u32_at(b: &[u8], at: usize) -> u32 {
    b.get(at..at + 4).and_then(|s| s.try_into().ok()).map(u32::from_le_bytes).unwrap_or(0)
}

/// A relative path that stays inside the destination: no roots, no "..".
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    let path: PathBuf = Path::new(&name.replace('\\', "/"))
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(Ok(tma_core::names::portable_name(&part.to_string_lossy()))),
            Component::CurDir => None,
            _ => Some(Err(())),
        })
        .collect::<Result<Vec<_>, _>>()
        .ok()?
        .into_iter()
        .collect();
    (!path.as_os_str().is_empty()).then_some(path)
}

/// Parse a FileGroupDescriptorW block; entries with unsafe names are dropped.
pub fn file_group(bytes: &[u8]) -> Vec<Described> {
    let count = u32_at(bytes, 0) as usize;
    (0..count.min(10_000))
        .map_while(|i| bytes.get(4 + i * DESCRIPTOR..4 + (i + 1) * DESCRIPTOR))
        .filter_map(|d| {
            let flags = u32_at(d, 0);
            let units: Vec<u16> = d[NAME_AT..].as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
            let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
            let name = String::from_utf16_lossy(&units[..end]);
            let is_dir = flags & FD_ATTRIBUTES != 0 && u32_at(d, 36) & DIRECTORY != 0;
            let size = (flags & FD_FILESIZE != 0).then(|| (u64::from(u32_at(d, 64)) << 32) | u64::from(u32_at(d, 68)));
            Some(Described { path: safe_relative(&name)?, is_dir, size })
        })
        .collect()
}

/// "Pasted image 2026-10-16 183405.png".
pub fn image_name(stamp: &str) -> String {
    format!("Pasted image {stamp}.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_come_from_copied_text() {
        let text = "\"C:\\Users\\me\\a.txt\"\r\nnot a path\r\n\\\\server\\share\\b.pdf\r\nD:/x/y.png";
        let paths = paths_in_text(text);
        assert_eq!(
            paths,
            [
                PathBuf::from("C:\\Users\\me\\a.txt"),
                PathBuf::from("\\\\server\\share\\b.pdf"),
                PathBuf::from("D:/x/y.png")
            ]
        );
        assert!(paths_in_text("hello world").is_empty());
    }

    fn descriptor(name: &str, flags: u32, attributes: u32, size: u64) -> Vec<u8> {
        let mut d = vec![0u8; DESCRIPTOR];
        d[0..4].copy_from_slice(&flags.to_le_bytes());
        d[36..40].copy_from_slice(&attributes.to_le_bytes());
        d[64..68].copy_from_slice(&((size >> 32) as u32).to_le_bytes());
        d[68..72].copy_from_slice(&(size as u32).to_le_bytes());
        for (i, unit) in name.encode_utf16().enumerate() {
            d[NAME_AT + i * 2..NAME_AT + i * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
        d
    }

    #[test]
    fn file_groups_parse_and_stay_inside() {
        let mut block = 4u32.to_le_bytes().to_vec();
        block.extend(descriptor("Report.pdf", FD_FILESIZE, 0, 5_000_000_000));
        block.extend(descriptor("Trip", FD_ATTRIBUTES, DIRECTORY, 0));
        block.extend(descriptor("Trip\\day1.jpg", 0, 0, 0));
        block.extend(descriptor("..\\..\\evil.exe", 0, 0, 0));
        let entries = file_group(&block);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0], Described { path: "Report.pdf".into(), is_dir: false, size: Some(5_000_000_000) });
        assert!(entries[1].is_dir);
        assert_eq!(entries[2].path, Path::new("Trip").join("day1.jpg"));
        // A count larger than the data stops at the data.
        let mut short = 9u32.to_le_bytes().to_vec();
        short.extend(descriptor("a.txt", 0, 0, 0));
        assert_eq!(file_group(&short).len(), 1);
    }

    #[test]
    fn pasted_images_are_named_by_time() {
        assert_eq!(image_name("2026-10-16 183405"), "Pasted image 2026-10-16 183405.png");
    }
}
