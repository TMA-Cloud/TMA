import { useApp, type FileItem } from '../../../contexts/AppContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useToast } from '../../../hooks/useToast';
import { isElectron } from '../../../utils/electronDesktop';
import { ONLYOFFICE_EXTS, getExt, validateOnlyOfficeMimeType } from '../../../utils/fileUtils';

/** Double-click / Enter on an item: enter a folder, or open a file in the right viewer. */
export function useFileOpen(afterOpen: () => void) {
  const {
    currentPath,
    openFolder,
    editFileWithDesktop,
    setImageViewerFile,
    setDocumentViewerFile,
    onlyOfficeConfigured,
    canConfigureOnlyOffice,
  } = useApp();
  const { can } = useAuth();
  const { showToast } = useToast();
  const isMobile = useIsMobile();

  /** False when it bailed out with a message, so the caller leaves selection alone. */
  const openOfficeDocument = (file: FileItem): boolean => {
    // Validate MIME type before opening (prevents unnecessary API calls)
    if (!validateOnlyOfficeMimeType(file.name, file.mimeType)) {
      const ext = getExt(file.name);
      showToast(`Can't open — this isn't a valid .${ext.slice(1)} file`, 'error');
      return false;
    }
    // Check if OnlyOffice is configured before opening (using cached value)
    if (!onlyOfficeConfigured) {
      if (isElectron()) {
        void editFileWithDesktop(file.id);
      } else if (canConfigureOnlyOffice) {
        showToast("OnlyOffice isn't set up — configure it in Settings", 'error');
      } else {
        showToast("OnlyOffice isn't set up — ask your administrator", 'error');
      }
      return false;
    }
    // On mobile, open in new tab instead of modal
    if (isMobile) {
      window.open(`/api/onlyoffice/viewer/${file.id}`, '_blank', 'noopener,noreferrer');
    } else {
      setDocumentViewerFile?.(file);
    }
    return true;
  };

  const openFile = (file: FileItem): boolean => {
    const mime = (file.mimeType || '').toLowerCase();
    const isOffice = ONLYOFFICE_EXTS.has(getExt(file.name));

    // In Electron every file goes to Windows, which opens its app or asks which one.
    if (isElectron()) {
      void editFileWithDesktop(file.id);
    } else if (mime.startsWith('image/')) {
      setImageViewerFile(file);
    } else if (isOffice) {
      return openOfficeDocument(file);
    }
    return true;
  };

  return (file: FileItem) => {
    // Don't allow opening anything from Trash
    if (currentPath[0] === 'Trash') return;

    if (file.type === 'folder') {
      openFolder(file);
    } else if (!can('files.download')) {
      // Every viewer reads the file's bytes, which the server gates on Download.
      showToast("You don't have permission to open files. Ask the account owner.", 'error');
    } else if (!openFile(file)) {
      return;
    }
    afterOpen();
  };
}
