/**
 * Electron desktop app integration.
 *
 * Types and usage here must match the API exposed by the preload script:
 * electron/src/preload/index.cjs (inlined API).
 * The renderer loads the same web app as the browser; this file is only
 * used when the app runs inside the Electron desktop client (Windows).
 */

declare global {
  interface Window {
    electronAPI?: {
      platform?: string;
      app?: {
        getVersion?: () => Promise<{ version: string | null; error?: string }>;
      };
      clipboard: {
        readFiles: () => Promise<{
          files: { name: string; mime: string; data: string }[];
        }>;
        writeFiles: (paths: string[]) => Promise<{ ok: boolean; error?: string }>;
        writeFilesFromData: (payload: {
          files: { name: string; data: string }[];
        }) => Promise<{ ok: boolean; error?: string }>;
        writeFilesFromServer: (payload: {
          origin: string;
          items: { id: string; name: string }[];
        }) => Promise<{ ok: boolean; error?: string }>;
      };
      files?: {
        editWithDesktop: (payload: { origin: string; item: { id: string; name: string } }) => Promise<{
          ok: boolean;
          error?: string;
        }>;
        saveFile: (payload: { origin: string; fileId: string; suggestedFileName: string }) => Promise<{
          ok: boolean;
          canceled?: boolean;
          error?: string;
        }>;
        saveFilesBulk: (payload: { origin: string; ids: string[] }) => Promise<{
          ok: boolean;
          canceled?: boolean;
          error?: string;
        }>;
      };
    };
  }
}

/** True when running inside the Windows Electron desktop app (clipboard + open on desktop supported). */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.clipboard && window.electronAPI?.platform === 'win32';
}

/** True when the desktop app exposes clipboard APIs (copy/paste to PC). Show "Copy to computer" / "Paste from computer". */
export function hasElectronClipboard(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.electronAPI?.clipboard?.readFiles &&
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

/** 200MB limit for "Copy to computer". */
export const MAX_COPY_TO_PC_BYTES = 200 * 1024 * 1024;
export function base64ToFile(base64: string, name: string, mime: string): File {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

/** Read files from OS clipboard (e.g. copy in Explorer). */
export async function getFilesFromElectronClipboard(): Promise<File[]> {
  if (!isElectron() || !window.electronAPI?.clipboard) return [];
  try {
    const { files } = await window.electronAPI.clipboard.readFiles();
    if (!files?.length) return [];
    return files.map(f => base64ToFile(f.data, f.name, f.mime));
  } catch {
    return [];
  }
}

/** Write file paths to OS clipboard (paste in Explorer). */
export async function writeFilesToElectronClipboard(paths: string[]): Promise<boolean> {
  if (!isElectron() || !window.electronAPI?.clipboard || !paths.length) return false;
  try {
    const result = await window.electronAPI.clipboard.writeFiles(paths);
    return result?.ok === true;
  } catch {
    return false;
  }
}

/** Fetch files and put on OS clipboard so user can paste in Explorer. */
export async function copyFilesToPcClipboard(
  items: { id: string; name: string }[]
): Promise<{ ok: boolean; error?: string }> {
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

export async function editFileWithDesktopElectron(payload: { id: string; name: string; mimeType: string }): Promise<{
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
    });
    return result ?? { ok: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/** Save multiple files as ZIP via Electron Save dialog. Returns ok: true on success so caller can show toast. */
export async function saveFilesBulkViaElectron(ids: string[]): Promise<{
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
    });
    return result ?? { ok: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}
