//! Paste takes the newer of two clipboards: TMA Cloud's own Copy or Cut, and
//! files copied in another app (Explorer), as Explorer itself does.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    InApp,
    System,
    Nothing,
}

/// `in_app` is the system clipboard's sequence number when TMA Cloud's Copy or
/// Cut happened; a different number now means another app wrote it since.
pub fn source(in_app: Option<u64>, system_has_files: bool, system_seq: u64) -> Source {
    match in_app {
        Some(seq) if !(system_has_files && system_seq != seq) => Source::InApp,
        _ if system_has_files => Source::System,
        _ => Source::Nothing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_clipboard_wins() {
        // Only one clipboard has something.
        assert_eq!(source(None, false, 7), Source::Nothing);
        assert_eq!(source(None, true, 7), Source::System);
        assert_eq!(source(Some(7), false, 9), Source::InApp);
        // Files copied in Explorer after the in-app Copy are pasted instead.
        assert_eq!(source(Some(7), true, 9), Source::System);
        // Explorer's copy predates the in-app Copy.
        assert_eq!(source(Some(7), true, 7), Source::InApp);
        // A host that cannot number the clipboard keeps the in-app copy.
        assert_eq!(source(Some(0), true, 0), Source::InApp);
    }
}
