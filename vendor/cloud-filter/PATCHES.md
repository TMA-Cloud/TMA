# cloud-filter 0.0.6, patched

A copy of [cloud-filter](https://crates.io/crates/cloud-filter) 0.0.6 (MIT, see
`LICENSE`), used through `[patch.crates-io]` in the workspace `Cargo.toml`.

The published crate calls `unwrap()` on the reply it sends Windows when a
callback fails. Windows may already have closed that request (the opening app
gave up, or the request was cancelled), and a panic inside a Windows callback
cannot unwind, so the desktop app aborted, and kept aborting at every start
while Windows retried the request.

Changes, each marked `Patched:` in the source:

- `src/filter/proxy.rs`: the six `fail(...).unwrap()` calls ignore the result.
- `src/filter/proxy.rs`, `src/command/commands.rs`: a failed download is reported over
  the range Windows requested (`Write::fail_range`). The original reported a zero-length
  range, which Windows rejects, so the app opening the file waited until it timed out.
- `src/root/connect.rs`: `Drop` ignores a failed `CfDisconnectSyncRoot`.

Drop this copy once an upstream release handles these errors.
