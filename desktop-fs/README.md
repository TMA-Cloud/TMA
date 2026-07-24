# TMA Cloud Drive host (`TmaCloudFs.exe`)

A [WinFsp](https://winfsp.dev) filesystem host that mounts TMA Cloud as a Windows
drive, so files can be opened and saved from any app's file dialogs. It holds no
credentials — every operation is forwarded over a local named pipe to the
Electron main process (`electron/src/main/clouddrive.cjs`), which makes the
authenticated backend calls.

For the architecture, how it fits the desktop app, and user-facing behavior, see
the wiki: **Concepts → Architecture (Cloud Drive)** and
**Getting Started → Desktop App (Cloud Drive)**.

## Build

Requires the .NET 9 SDK and WinFsp installed.

```powershell
dotnet build -c Release      # dev build -> bin/Release/TmaCloudFs.exe
```

Packaging is handled by `electron/scripts/build-clouddrive.js` (publishes a
self-contained win-x64 build and bundles the WinFsp installer); see the desktop
app build docs.

## Format & lint

Both are handled by `dotnet format` (built into the .NET SDK), driven by
[`.editorconfig`](.editorconfig). The `.csproj` also enables the .NET analyzers,
so `dotnet build` surfaces the same style/quality warnings (non-fatal).

```powershell
dotnet format --verify-no-changes    # check only (CI / pre-commit)
dotnet format                         # auto-fix formatting + style
```

## Test

Mounts the filesystem against an in-memory mock bridge (no backend or login) and
exercises list/read/write/overwrite/mkdir/rename/move/delete:

```powershell
powershell -ExecutionPolicy Bypass -File test/run-mount-test.ps1
```

Pass `--debug` to `TmaCloudFs.exe` for WinFsp's own verbose logging.

## Pipe protocol

Newline-delimited JSON over the named pipe. `rid` is the RPC correlation id (kept
distinct from any `id` argument an op carries). Bulk file bytes never travel on
the pipe — both processes share `%TEMP%`, so downloads/uploads exchange temp-file
paths.

| op         | args                       | result                                  |
| ---------- | -------------------------- | --------------------------------------- |
| `list`     | `parentId?`                | array of `{id,name,type,size,modified}` |
| `download` | `id`, `dest`               | writes file bytes to `dest`             |
| `upload`   | `parentId?`, `name`, `src` | created file `{id,...}`                 |
| `replace`  | `id`, `name`, `src`        | `{ok}`                                  |
| `mkdir`    | `name`, `parentId?`        | folder `{id,...}`                       |
| `rename`   | `id`, `name`               | `{id,name}`                             |
| `move`     | `ids[]`, `parentId?`       | `{ok}`                                  |
| `delete`   | `ids[]`                    | `{ok}`                                  |
| `stats`    | –                          | `{used,total,free}`                     |

Server → client pushes (no `rid`): `{"push":"invalidate","path"?}` and
`{"push":"mode","mode":"full"|"saveonly"}`.
