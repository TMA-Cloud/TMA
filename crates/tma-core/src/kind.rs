//! Sorts a file into one of a small set of kinds, each with its own artwork.
//! The extension decides first: it is what the user named and what the OS opens
//! the file with, while uploads often arrive as `application/octet-stream`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Document,
    Pdf,
    Spreadsheet,
    Presentation,
    Image,
    Design,
    Video,
    Audio,
    Archive,
    Code,
    Database,
    Text,
    Executable,
    Font,
    Generic,
}

impl FileKind {
    /// Short human label, e.g. for the share page ("PDF · Document").
    pub fn label(self) -> &'static str {
        match self {
            Self::Document | Self::Pdf => "Document",
            Self::Spreadsheet => "Spreadsheet",
            Self::Presentation => "Presentation",
            Self::Image => "Image",
            Self::Design => "Design file",
            Self::Video => "Video",
            Self::Audio => "Audio",
            Self::Archive => "Archive",
            Self::Code => "Code",
            Self::Database => "Database",
            Self::Text => "Text",
            Self::Executable => "Application",
            Self::Font => "Font",
            Self::Generic => "File",
        }
    }

    /// Content that is already compressed gains nothing from deflate in a ZIP.
    pub fn is_precompressed(self) -> bool {
        matches!(self, Self::Image | Self::Video | Self::Audio | Self::Archive)
    }
}

// Space-separated so each kind stays one line.
const EXTENSIONS: &[(FileKind, &str)] = &[
    (FileKind::Document, "doc docx docm dot dotx odt rtf pages wpd epub mobi azw azw3 kfx xps oxps"),
    (FileKind::Pdf, "pdf"),
    (FileKind::Spreadsheet, "xls xlsx xlsm xlsb xlt xltx ods csv tsv numbers"),
    (FileKind::Presentation, "ppt pptx pptm pps ppsx pot potx odp key"),
    (
        FileKind::Image,
        "png jpg jpeg gif webp avif bmp svg ico tif tiff heic heif raw jxl cr2 cr3 nef arw dng raf orf rw2 pef srw dcm",
    ),
    (
        FileKind::Design,
        "ai eps psd psb indd idml xd sketch fig afdesign afphoto afpub cdr xcf kra procreate clip odg lottie riv",
    ),
    (FileKind::Video, "mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp mts m2ts hevc flc"),
    (FileKind::Audio, "mp3 wav flac aac m4a ogg oga opus wma aiff aif mid midi"),
    (FileKind::Archive, "zip zipx rar 7z tar gz tgz bz2 xz lz lzma zst lz4 br cab z cbz cbr"),
    (
        FileKind::Code,
        "js jsx mjs cjs ts tsx json html htm css scss less py rb php java kt c h cpp hpp cs go rs swift sh ps1 bat cmd xml yaml yml toml ini vue svelte astro lua r pl dart zig scala kts ex exs hs ml clj graphql gql proto tf hcl nix ipynb jsonc json5 qml",
    ),
    (FileKind::Database, "db sqlite sqlite3 sql mdb accdb dbf parquet arrow feather avro orc"),
    (FileKind::Text, "txt md markdown log rst nfo srt"),
    (
        FileKind::Executable,
        "exe msi msix appx apk aab app dmg pkg deb rpm iso img jar appimage snap flatpak ipa xpi crx",
    ),
    (FileKind::Font, "ttf otf woff woff2 eot"),
];

fn kind_from_extension(ext: &str) -> Option<FileKind> {
    EXTENSIONS.iter().find(|(_, list)| list.split(' ').any(|e| e == ext)).map(|(kind, _)| *kind)
}

fn is_code_subtype(mime: &str) -> bool {
    // Whole subtype only: a substring would put x-shockwave-flash under x-sh.
    let Some((_, sub)) = mime.split_once('/') else { return false };
    let sub = sub.strip_prefix("x-").unwrap_or(sub);
    matches!(
        sub,
        "javascript" | "typescript" | "json" | "xml" | "xhtml" | "html" | "css" | "sh" | "shellscript" | "python"
    )
}

/// Kind from a MIME type alone; rules are checked in order and the first hit wins.
pub fn kind_from_mime(mime_type: &str) -> FileKind {
    // An RFC 6839 suffix names the container, not the content.
    let essence = mime_type.to_ascii_lowercase();
    let essence = essence.split(';').next().unwrap_or("").trim().to_string();
    let mime = match essence.rfind('+') {
        Some(i) if essence[i + 1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => &essence[..i],
        _ => essence.as_str(),
    };
    let has = |s: &str| mime.contains(s);
    if mime == "application/pdf" {
        FileKind::Pdf
    } else if has("photoshop") || has("postscript") || has("illustrator") {
        FileKind::Design
    } else if mime.starts_with("image/") {
        FileKind::Image
    } else if mime.starts_with("video/") {
        FileKind::Video
    } else if mime.starts_with("audio/") {
        FileKind::Audio
    } else if mime.starts_with("font/") {
        FileKind::Font
    } else if has("spreadsheet") || has("excel") || mime == "text/csv" {
        FileKind::Spreadsheet
    } else if has("presentation") || has("powerpoint") {
        FileKind::Presentation
    } else if has("wordprocessing") || has("msword") || has("opendocument.text") {
        FileKind::Document
    } else if has("zip") || has("compressed") || has("x-tar") || has("x-7z") || has("x-rar") || has("gzip") {
        FileKind::Archive
    } else if is_code_subtype(mime) {
        FileKind::Code
    } else if has("sql") {
        FileKind::Database
    } else if has("executable") || has("msdownload") || has("x-msi") {
        FileKind::Executable
    } else if mime.starts_with("text/") {
        FileKind::Text
    } else {
        FileKind::Generic
    }
}

/// The kind of a file from its name, falling back to the stored MIME type.
pub fn file_kind(name: &str, mime_type: Option<&str>) -> FileKind {
    let ext = crate::names::extension_of(name);
    if !ext.is_empty() {
        if let Some(kind) = kind_from_extension(&ext) {
            return kind;
        }
        // An extension the table lacks is looked up in the MIME database.
        if let Some(guess) = mime_guess::from_ext(&ext).first_raw() {
            return kind_from_mime(guess);
        }
        return FileKind::Generic;
    }
    mime_type.map(kind_from_mime).unwrap_or(FileKind::Generic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_wins_over_mime() {
        assert_eq!(file_kind("clip.ts", Some("video/mp2t")), FileKind::Code);
        assert_eq!(file_kind("report.PDF", None), FileKind::Pdf);
        assert_eq!(file_kind("photo.jpeg", Some("application/octet-stream")), FileKind::Image);
    }

    #[test]
    fn hidden_files_use_mime() {
        assert_eq!(file_kind(".bashrc", Some("text/plain")), FileKind::Text);
        assert_eq!(file_kind("README", None), FileKind::Generic);
    }

    #[test]
    fn mime_rules() {
        assert_eq!(kind_from_mime("application/atom+xml"), FileKind::Generic);
        assert_eq!(kind_from_mime("image/svg+xml"), FileKind::Image);
        assert_eq!(kind_from_mime("application/x-shockwave-flash"), FileKind::Generic);
        assert_eq!(kind_from_mime("text/csv; charset=utf-8"), FileKind::Spreadsheet);
    }
}
