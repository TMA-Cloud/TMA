# TMA Cloud

Self-hosted cloud storage: an Express API with a background worker, a React web
app, an Electron desktop app for Windows, and a WinFsp host that mounts the store
as a Windows drive. User docs live in the [Wiki](https://tma-cloud.github.io/Wiki).

| Package       | Stack                                         | What it is                                          |
| ------------- | --------------------------------------------- | --------------------------------------------------- |
| `backend/`    | Node (CommonJS), Express, Postgres, Redis, S3 | API (`server.js`) and worker (`audit-worker.js`)    |
| `frontend/`   | React, TypeScript, Vite, Tailwind             | Web app, also loaded by the desktop app             |
| `electron/`   | Electron main process (`.cjs`)                | Windows desktop app, updater, Cloud Drive bridge    |
| `desktop-fs/` | C# / .NET 10, WinFsp                          | Cloud Drive host, mounts the REST store as a volume |

Every package has its own `package.json` (or `.csproj`) and lockfile. There is no
root workspace, so run each command inside its package directory. Node `^22 || ^24 || >=26`
(CI and Docker use 26). The root `Dockerfile` builds frontend and backend into a
single image; `make build` tags it with the backend version.

## Rules for every package

- **No source file over 550 real lines.** Blank lines and comments don't count.
  ESLint's `max-lines` enforces this for the JS/TS packages; tests, `scripts/` and
  `migrations/` are exempt. In `desktop-fs/` it is a review convention. When a
  file reaches the limit, split it. Don't raise the limit.
- **Refactors keep public shapes stable.** Exported names, import paths, props and
  context values stay the same, so no consumer has to change. Behaviour and tests
  stay the same too.
- **Split by concern and keep the barrel.** The oversized file becomes an index
  that re-exports its focused siblings from a folder of the same name. Shared
  private helpers go in a `*.helpers.*` sibling. Keep the import graph acyclic.
- **Pure logic goes in its own module** so tests can cover it directly.
- **Comments are short and explain why**, in one line rather than a paragraph.
  Don't restate the code or narrate it, and don't add `// ==== Banner ====`
  dividers, since the filename already names the concern.
- Never commit `.env` or secrets. New settings go in `.env.example` with a comment.

## backend/

Layers: `routes → controllers → services / models → utils / config`.

- **Routes** connect URLs to controller handlers and hold no logic.
- **Controllers** parse the request, call a model or service, and shape the
  response. No SQL or business rules.
- **Models** own the database (SQL and caching). **Services** own cross-cutting
  work such as the audit queue, events and share URLs.
- **Utils** are pure, stateless helpers. **Config** is wiring (db, logger, storage).
- Splits to copy: `controllers/file.controller.js` over `controllers/file/` (split
  by HTTP concern: `file.upload`, `file.download`, `file.listing`) and
  `models/file.model.js` over `models/file/`. Shared helpers:
  `controllers/file/file.upload.helpers.js`, `models/user/user.admin.helpers.model.js`.
  Pure logic: `utils/fileEncryption/format.js`.
- **Migrations** are `migrations/NNN_snake_case.sql`, numbered after the highest
  existing number. `server.js` applies them at startup, each one atomically and
  under an advisory lock. Never edit a migration that has shipped. Add a new one.
- Durable or slow work belongs in the worker, not on the API request path.
- `npm run knip` fails on unused files, exports and dependencies (config in
  `knip.jsonc`). Modules export through one `export { ... }` list, which
  knip's `@internal` tag cannot mark, so the production check that ignores
  tests is an audit, `npm run knip:production`, not a gate. Its findings
  should all be test seams: exports a module uses itself and tests reach.
- Tests: `tests/unit` (mocked), `tests/integration*` (needs Postgres and Redis
  from `.env`), `tests/integration-s3` (`npm run test:s3`). See
  [the testing guide](https://tma-cloud.github.io/Wiki/docs/guides/operations/testing).

## frontend/

- **Providers compose and hooks implement.** A provider only wires hooks together
  and builds the context value, with no `fetch` or business logic inline. Each
  concern gets its own `useX` hook. Example: `contexts/AppProvider.tsx` over `contexts/app/`.
- **One concern per hook.** Shared plumbing (operation queue, `refreshFiles`,
  shared refs) comes in as arguments, never from a global.
- **Components render and hooks hold the logic.** Keyboard handling, drag-and-drop,
  marquee selection, clipboard and modal state machines go in a hook in a local
  `hooks/` folder. Examples: `components/fileManager/hooks/`, `components/upload/useUploadStaging.ts`.
- **Pure logic goes in plain modules**, such as `contexts/app/helpers.ts` and
  `components/upload/uploadStaging.ts`.
- **The API layer is split by domain** in `utils/api/` and re-exported by
  `utils/api.ts`, so code keeps importing `from '../utils/api'`.
- CSS uses ITCSS-ordered partials under `src/styles/` (tokens → base → components
  → utilities), imported by `index.css`. Use tokens, not literal colours.
- `npm run knip` fails on unused files, exports and dependencies, first with
  tests and then without them. An export only tests use is dead unless it is a
  test seam; tag that `/** @internal Exported for tests. */`. Config lives in
  `knip.jsonc`.
- New cross-cutting conventions become rules in the local `house` ESLint plugin
  (`eslint-rules/house.js`). Make a rule an error only where the code already
  follows it, then widen it over time.

## electron/

Main process only (`src/main/`), organised by concern:

- **`index.cjs`** is the entry point. It creates the window, registers IPC handlers
  and schedules cleanup, with no feature logic inline.
- **`ipc/`** has one file per IPC surface (`files`, `clipboard`, `app`). A handler
  validates the sender (`ipcGuard.cjs`), parses the payload, calls a util and
  shapes the reply.
- **`utils/`** holds stateless helpers (`file-utils`, `mime-types`, `powershell`).
- **`config.cjs`, `window.cjs`, `updater.cjs`, `theme.cjs`** are wiring.
- **`clouddrive/`** is the WinFsp bridge: pipe RPC, SSE and the mount lifecycle.
- Splits to copy: `utils/file-utils.cjs` over `utils/file-utils/` (`http`,
  `download`, `upload`) and `ipc/clipboard.cjs` over `ipc/clipboard/`.
- **Mutable state that tests reset through `freshRequire` must live in the barrel**,
  because `freshRequire` only clears the barrel's own cache entry, not a
  submodule's. Put the state in a class or factory that the barrel instantiates,
  as in `clouddrive/driver.cjs` → `clouddrive.cjs` and `ipc/files/watchers.cjs` →
  `ipc/files.cjs`. Stateless modules can stay plain.
- **Resolve `child_process.spawn` at call time** (`require('child_process').spawn`)
  in a cached module. If you destructure it at the top, it binds to a stale test
  spy. Calling `net.createServer` on the object is fine.
- Tests replace the Electron runtime with an in-memory double, so they run on any
  OS without a display.
- `npm run knip` fails on unused files, exports and dependencies, with tests
  and without them (config in `knip.jsonc`). knip reads destructured
  `require` and named imports; it cannot see a member read off a default
  import, so tests import helpers by name.

## desktop-fs/

A small WinFsp host. Electron holds the credentials and makes the authenticated
REST calls; this process only talks to Electron over a named pipe.

- **`Program.cs`** is the entry point: the `Fsp.Service` host, argument parsing and mount.
- **`Bridge.cs`** is the JSON-RPC client that talks to Electron over the pipe.
- **`Node.cs`** has the data model (`Node`, `DirCache`, `OpenFile`). Keep these
  types here, not in the partials.
- **`CloudFileSystem` is split with `partial class`, not new types**, because all
  its overrides belong to WinFsp's one `FileSystemBase` contract. Each concern
  gets its own `CloudFileSystem.<Concern>.cs`: `Volume`, `Lookup`, `ReadWrite`,
  `DeleteRename`, `Security`, `Directory`, `Backend`, `Helpers`. The core
  `CloudFileSystem.cs` keeps the fields, constants, constructor, `RefreshStats`
  and `Dispose`. The SDK compiles every `.cs` file, so no `.csproj` edit is needed.
- Files use CRLF line endings (`.editorconfig`, `.gitattributes`). Use XML `///`
  docs only where their length is justified.

## Before you finish

Run these in each package you touched. CI (`.github/workflows/test.yml`) runs the
same commands, except for desktop-fs.

| Package       | Commands                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/`    | `npm run lint` · `npm run format:check` · `npm run knip` · `npm test` · `npm run test:integration`                                                                  |
| `frontend/`   | `npm run lint` · `npm run format:check` · `npx tsc --noEmit -p tsconfig.app.json` · `npx tsc -b tsconfig.test.json` · `npm run knip` · `npm test` · `npm run build` |
| `electron/`   | `npm run lint` · `npm run format:check` · `npm run knip` · `npm test`                                                                                               |
| `desktop-fs/` | `dotnet build` (0 warnings, 0 errors) · `dotnet format --verify-no-changes`                                                                                         |
| Root scripts  | `shellcheck setup.sh update.sh rotate.sh scripts/db-backup-restore.sh`                                                                                              |

## Git

- **Hooks** live in `.githooks/`. Turn them on once per clone with `make hooks`
  (which runs `git config core.hooksPath .githooks`).
  - `pre-commit` checks only staged files: Prettier and ESLint per package,
    `dotnet format whitespace` for `.cs` files, and blocks `.env` files, conflict
    markers and files over 5 MB.
  - `commit-msg` enforces the message rules below.
  - `pre-push` runs lint, format check and unit tests for each package changed
    since the upstream branch.
  - Bypass with `--no-verify` only when you have a good reason.
- **Commit messages** follow git's own conventions (`commit-msg` enforces them):
  - The subject is imperative and in sentence case ("Lock Cloud Drive creates per
    path instead of globally"). Aim for 50 characters; 72 is the hard limit. No
    trailing period and no `feat:` prefixes.
  - Leave a blank line after the subject, then a body that says what was wrong
    and why this fixes it, not how. Wrap it at 72 columns. URLs, trailers and
    indented code are exempt.
  - Keep the body short: about 20 lines at most, and 40 is the hard limit. A
    longer body usually means the commit should be split.
  - Always sign off with `git commit -s`.
- Version bumps get their own commit ("Bump backend frontend electron versions").
