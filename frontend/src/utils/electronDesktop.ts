/**
 * Electron desktop app integration.
 *
 * Types and usage here must match the API exposed by the preload script:
 * electron/src/preload/index.cjs (inlined API).
 * The renderer loads the same web app as the browser; this file is only
 * used when the app runs inside the Electron desktop client (Windows).
 */

/** Cloud drive behavior: 'full' = files openable; 'saveOnly' = browse + Save-As, content reads denied. */
export type CloudDriveMode = 'full' | 'saveOnly';

/** One event per file as its card opens and closes, then a summary per paste. */
export type ClipboardUploadStatus =
  | { state: 'started'; id: string; fileName: string; fileSize?: number }
  | { state: 'completed'; id: string; fileName: string }
  | { state: 'error'; id: string; fileName: string; error?: string }
  | { state: 'finished'; batchId: string; saved: number; failed: { fileName: string; reason: string }[] };

declare global {
  interface Window {
    electronAPI?: {
      platform?: string;
      app?: {
        getVersion?: () => Promise<{ version: string | null; error?: string }>;
        downloadAndInstallUpdate?: (version: string) => Promise<{ ok: boolean; error?: string }>;
        onUpdateDownloadProgress?: (callback: (percent: number) => void) => () => void;
        setTheme?: (theme: 'light' | 'dark') => Promise<{ ok: boolean }>;
      };
      clipboard: {
        /** `external`: files another app copied after this app's last Copy or Cut. */
        peekFileNames?: () => Promise<{ names: string[]; external?: boolean }>;
        claim?: (payload: { names: string[] }) => Promise<{ ok: boolean }>;
        // A refused file lands in `failed`, not in `ok`: see onUploadStatus.
        uploadFiles?: (payload: { origin: string; parentId: string | null }) => Promise<{
          ok: boolean;
          fallback?: boolean;
          names?: string[];
          failed?: { fileName: string; reason: string }[];
          error?: string;
        }>;
        uploadVirtualFiles?: (payload: { origin: string; parentId: string | null }) => Promise<{
          ok: boolean;
          empty?: boolean;
          names?: string[];
          failed?: { fileName: string; reason: string }[];
          error?: string;
        }>;
        /** Abort an in-flight clipboard upload by its upload id. */
        cancelUpload?: (uploadId: string) => Promise<{ ok: boolean }>;
        /** Per-file card events, then one `finished` summary per paste. */
        onUploadStatus?: (callback: (payload: ClipboardUploadStatus) => void) => () => void;
        /** Byte progress for an in-flight clipboard upload; `id` matches onUploadStatus. */
        onUploadProgress?: (callback: (payload: { id: string; loaded: number; total: number }) => void) => () => void;
        writeFilesFromServer: (payload: {
          origin: string;
          items: { id: string; name: string }[];
        }) => Promise<{ ok: boolean; error?: string; superseded?: boolean }>;
      };
      files?: {
        editWithDesktop: (payload: { origin: string; item: { id: string; name: string } }) => Promise<{
          ok: boolean;
          error?: string;
        }>;
        saveFile: (payload: {
          origin: string;
          fileId: string;
          suggestedFileName: string;
          downloadId?: string;
        }) => Promise<{
          ok: boolean;
          canceled?: boolean;
          error?: string;
        }>;
        saveFilesBulk: (payload: { origin: string; ids: string[]; downloadId?: string }) => Promise<{
          ok: boolean;
          canceled?: boolean;
          error?: string;
        }>;
        /** Byte progress for an in-flight save; `id` is the downloadId from the save payload. */
        onSaveProgress?: (callback: (payload: { id: string; loaded: number; total: number }) => void) => () => void;
        /** Byte progress while opening a file on the desktop; `id` is the file id. */
        onOpenProgress?: (callback: (payload: { id: string; loaded: number; total: number }) => void) => () => void;
        onDerivedUploadStatus?: (
          callback: (payload: {
            state: 'started' | 'completed' | 'error';
            fileName: string;
            size?: number;
            originalId?: string;
            error?: string;
          }) => void
        ) => () => void;
      };
      cloudDrive?: {
        status: () => Promise<{ running: boolean; mountPoint: string | null; mode?: CloudDriveMode }>;
        /** Re-read the mode the first user set on the server and apply it to the drive. */
        refreshMode?: () => Promise<{ mode: CloudDriveMode }>;
      };
    };
  }
}

/** True when running inside the Windows Electron desktop app (clipboard + open on desktop supported). */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.clipboard && window.electronAPI?.platform === 'win32';
}

/** True when the desktop app can mount the cloud as a Windows drive (WinFsp). */
export function hasElectronCloudDrive(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.cloudDrive?.status;
}

/**
 * Have the drive re-read its mode from the server and report what it now
 * applies. Null outside the desktop app; save-only when the answer is unclear.
 */
export async function refreshElectronCloudDriveMode(): Promise<CloudDriveMode | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.cloudDrive?.refreshMode) return null;
  try {
    const res = await api.cloudDrive.refreshMode();
    return res?.mode === 'full' ? 'full' : 'saveOnly';
  } catch {
    return 'saveOnly';
  }
}

/** True when the desktop app exposes clipboard APIs (copy/paste to PC). Show "Copy to computer" / "Paste from computer". */
export function hasElectronClipboard(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.electronAPI?.clipboard?.uploadFiles &&
    !!window.electronAPI?.clipboard?.writeFilesFromServer
  );
}

/** True when the desktop app supports opening files in the system default app. Show "Open on desktop". */
export function hasElectronOpenOnDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.files?.editWithDesktop;
}

/** Read the packaged desktop app version (Electron main process app.getVersion()). */
export async function getElectronAppVersion(): Promise<string | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.app?.getVersion) return null;
  try {
    const res = await api.app.getVersion();
    return typeof res?.version === 'string' && res.version.length > 0 ? res.version : null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to download progress (0–100) while the Electron update installer is downloading.
 * Returns an unsubscribe function.
 */
export function subscribeToUpdateDownloadProgress(callback: (percent: number) => void): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.app?.onUpdateDownloadProgress) return () => {};
  return api.app.onUpdateDownloadProgress(callback);
}

/**
 * Download the installer from &lt;updatorUrl&gt;/v&lt;version&gt; and launch it.
 * Requires updatorUrl to be set in electron build-config.json.
 */
export async function downloadAndInstallElectronUpdate(
  latestVersion: string
): Promise<{ ok: boolean; error?: string }> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.app?.downloadAndInstallUpdate) {
    return { ok: false, error: 'Not available' };
  }
  try {
    return await api.app.downloadAndInstallUpdate(latestVersion);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/** 200MB limit for "Copy to computer". */
export const MAX_COPY_TO_PC_BYTES = 200 * 1024 * 1024;
/**
 * True when another app put files on the OS clipboard after this app's last
 * Copy or Cut: those are newer, so a paste should upload them instead.
 */
export async function hasExternalElectronClipboardFiles(): Promise<boolean> {
  if (!isElectron() || !window.electronAPI?.clipboard?.peekFileNames) return false;
  try {
    const { external } = await window.electronAPI.clipboard.peekFileNames();
    return external === true;
  } catch {
    return false;
  }
}

/** Take the OS clipboard for an in-app Copy or Cut that has nothing to put there for Explorer. */
export async function claimElectronClipboard(names: string[]): Promise<void> {
  if (!isElectron() || !window.electronAPI?.clipboard?.claim || names.length === 0) return;
  try {
    await window.electronAPI.clipboard.claim({ names });
  } catch {
    // Best effort: the cloud clipboard still holds the selection.
  }
}

/** Upload physical or virtual clipboard files directly from Electron's main process. */
export async function uploadElectronClipboardFiles(parentId: string | null): Promise<{
  ok: boolean;
  fallback?: boolean;
  error?: string;
}> {
  const uploadFiles = window.electronAPI?.clipboard?.uploadFiles;
  if (!isElectron() || !uploadFiles) return { ok: false, fallback: true };
  try {
    const physical = await uploadFiles({ origin: window.location.origin, parentId });
    if (!physical.fallback) return physical;
    const uploadVirtualFiles = window.electronAPI?.clipboard?.uploadVirtualFiles;
    if (!uploadVirtualFiles) return { ok: false, fallback: true };
    const virtual = await uploadVirtualFiles({ origin: window.location.origin, parentId });
    return virtual.empty ? { ok: false, fallback: true } : virtual;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fetch files and put on OS clipboard so user can paste in Explorer. */
export async function copyFilesToPcClipboard(
  items: { id: string; name: string }[]
): Promise<{ ok: boolean; error?: string; superseded?: boolean }> {
  try {
    const clip = window.electronAPI?.clipboard;
    if (!isElectron() || !clip?.writeFilesFromServer || !items.length) {
      return { ok: false, error: 'Not available' };
    }

    const origin = window.location.origin;
    const result = await clip.writeFilesFromServer({ origin, items });
    return result ?? { ok: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

export async function editFileWithDesktopElectron(payload: { id: string; name: string }): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const api = window.electronAPI;
    if (!isElectron() || !api?.files?.editWithDesktop) {
      return {
        ok: false,
        error: 'Desktop editing is only available in the Windows app.',
      };
    }

    const result = await api.files.editWithDesktop({
      origin: window.location.origin,
      item: { id: payload.id, name: payload.name },
    });

    if (!result || !result.ok) {
      return {
        ok: false,
        error: result?.error || 'Failed to edit file on desktop.',
      };
    }

    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/** Save a single file via Electron Save dialog (title shows app name). Returns ok: true on success so caller can show toast. */
export async function saveFileViaElectron(payload: {
  fileId: string;
  suggestedFileName: string;
  downloadId?: string;
}): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const api = window.electronAPI;
  if (!isElectron() || !api?.files?.saveFile) {
    return { ok: false, error: 'Not available' };
  }
  try {
    const result = await api.files.saveFile({
      origin: window.location.origin,
      fileId: payload.fileId,
      suggestedFileName: payload.suggestedFileName,
      ...(payload.downloadId ? { downloadId: payload.downloadId } : {}),
    });
    return result ?? { ok: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/** Save multiple files as ZIP via Electron Save dialog. Returns ok: true on success so caller can show toast. */
export async function saveFilesBulkViaElectron(
  ids: string[],
  downloadId?: string
): Promise<{
  ok: boolean;
  canceled?: boolean;
  error?: string;
}> {
  const api = window.electronAPI;
  if (!isElectron() || !api?.files?.saveFilesBulk) {
    return { ok: false, error: 'Not available' };
  }
  try {
    const result = await api.files.saveFilesBulk({
      origin: window.location.origin,
      ids,
      ...(downloadId ? { downloadId } : {}),
    });
    return result ?? { ok: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * Subscribe to byte progress for Electron file saves. The callback fires with the
 * downloadId passed to saveFile/saveFilesBulk. Returns an unsubscribe function;
 * no-op outside the desktop app.
 */
export function subscribeToElectronSaveProgress(
  callback: (payload: { id: string; loaded: number; total: number }) => void
): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.files?.onSaveProgress) return () => {};
  return api.files.onSaveProgress(callback);
}

/**
 * Subscribe to clipboard upload cards opening and closing in the main process.
 * Returns an unsubscribe function; no-op on the web.
 */
export function subscribeToElectronClipboardUploadStatus(
  callback: (payload: ClipboardUploadStatus) => void
): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.clipboard?.onUploadStatus) return () => {};
  return api.clipboard.onUploadStatus(callback);
}

/**
 * Subscribe to byte progress for an in-flight clipboard upload, keyed by the id
 * from the status event. Returns an unsubscribe function.
 */
export function subscribeToElectronClipboardUploadProgress(
  callback: (payload: { id: string; loaded: number; total: number }) => void
): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.clipboard?.onUploadProgress) return () => {};
  return api.clipboard.onUploadProgress(callback);
}

/** Abort a clipboard upload running in the main process. True when it was still in flight. */
export async function cancelElectronClipboardUpload(uploadId: string): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.clipboard?.cancelUpload) return false;
  try {
    const result = await api.clipboard.cancelUpload(uploadId);
    return !!result?.ok;
  } catch {
    return false;
  }
}

/**
 * Subscribe to byte progress while opening a file on the desktop. The callback
 * fires with the file's id. Returns an unsubscribe function; no-op on the web.
 */
export function subscribeToElectronOpenProgress(
  callback: (payload: { id: string; loaded: number; total: number }) => void
): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!isElectron() || !api?.files?.onOpenProgress) return () => {};
  return api.files.onOpenProgress(callback);
}
