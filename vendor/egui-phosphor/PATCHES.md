# egui-phosphor 0.14.0, patched

A copy of [egui-phosphor](https://crates.io/crates/egui-phosphor) 0.14.0 (MIT or
Apache-2.0, see `LICENSE-MIT` and `LICENSE-APACHE`; the Phosphor icons are MIT),
used through `[patch.crates-io]` in the workspace `Cargo.toml`.

The published crate requires egui 0.36, and no release supports egui 0.37 yet, so
it kept the whole interface on egui 0.36. The crate only uses egui's font types,
which 0.37 did not change.

Changes:

- `Cargo.toml`: egui `0.37` instead of `0.36`. The dev-dependencies, examples and
  tests are left out.
- Only the `regular` and `fill` fonts (`res/Phosphor.ttf`, `res/Phosphor-Fill.ttf`)
  and their sources are kept, the two variants the app uses. `thin`, `light`, `bold`
  and `subset` stay declared but fail to build if enabled.

The source files are unchanged. Drop this copy once an egui-phosphor release
supports the egui version the workspace uses.
