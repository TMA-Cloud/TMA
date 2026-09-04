import React from 'react';
import { AppContext } from './AppContext';
import { useAuth } from './AuthContext';
import { useToast } from '../hooks/useToast';
import { usePromiseQueue } from '../utils/debounce';
import { useUiState } from './app/useUiState';
import { useFileBrowser } from './app/useFileBrowser';
import { useUploads } from './app/useUploads';
import { useFileOperations } from './app/useFileOperations';
import { useClipboard } from './app/useClipboard';
import { useDownloads } from './app/useDownloads';
import { useDesktopEdit } from './app/useDesktopEdit';
import { useServerEvents } from './app/useServerEvents';
import { useAppConfig } from './app/useAppConfig';
import { useAppUpdates } from './app/useAppUpdates';

/** Composition root: wires the per-concern hooks in ./app/ together and builds the AppContext value. */
export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { showToast } = useToast();
  const { user } = useAuth();
  const operationQueue = usePromiseQueue();

  const ui = useUiState();
  const browser = useFileBrowser(ui.setSelectedFiles);

  const uploads = useUploads({
    showToast,
    operationQueue,
    folderStack: browser.folderStack,
    refreshFiles: browser.refreshFiles,
    debouncedRefreshFiles: browser.debouncedRefreshFiles,
  });

  const operations = useFileOperations({
    showToast,
    operationQueue,
    folderStack: browser.folderStack,
    refreshFiles: browser.refreshFiles,
    refreshOrResearch: browser.refreshOrResearch,
  });

  const clipboard = useClipboard({
    showToast,
    operationQueue,
    files: browser.files,
    refreshFiles: browser.refreshFiles,
    uploadFilesBulk: uploads.uploadFilesBulk,
  });

  const downloads = useDownloads({ showToast, files: browser.files });

  const desktopEdit = useDesktopEdit({
    showToast,
    files: browser.files,
    debouncedRefreshFiles: browser.debouncedRefreshFiles,
  });

  const config = useAppConfig();
  const updates = useAppUpdates({ userId: user?.id });

  useServerEvents({
    currentPathRef: browser.currentPathRef,
    folderStackRef: browser.folderStackRef,
    refreshFilesRef: browser.refreshFilesRef,
  });

  return (
    <AppContext.Provider
      value={{
        // File browser: location, navigation, listing, sort, search
        currentPath: browser.currentPath,
        folderStack: browser.folderStack,
        folderSharedStack: browser.folderSharedStack,
        files: browser.files,
        setFiles: browser.setFiles,
        refreshFiles: browser.refreshFiles,
        setCurrentPath: browser.setCurrentPath,
        openFolder: browser.openFolder,
        navigateTo: browser.navigateTo,
        canGoBack: browser.canGoBack,
        canGoForward: browser.canGoForward,
        goBack: browser.goBack,
        goForward: browser.goForward,
        sortBy: browser.sortBy,
        sortOrder: browser.sortOrder,
        setSortBy: browser.setSortBy,
        setSortOrder: browser.setSortOrder,
        searchQuery: browser.searchQuery,
        setSearchQuery: browser.setSearchQuery,
        isSearching: browser.isSearching,
        searchFiles: browser.searchFiles,

        // UI: selection, view toggles, modals
        selectedFiles: ui.selectedFiles,
        setSelectedFiles: ui.setSelectedFiles,
        addSelectedFile: ui.addSelectedFile,
        removeSelectedFile: ui.removeSelectedFile,
        clearSelection: ui.clearSelection,
        viewMode: ui.viewMode,
        setViewMode: ui.setViewMode,
        sidebarOpen: ui.sidebarOpen,
        setSidebarOpen: ui.setSidebarOpen,
        uploadModalOpen: ui.uploadModalOpen,
        setUploadModalOpen: ui.setUploadModalOpen,
        uploadModalProcessing: ui.uploadModalProcessing,
        setUploadModalProcessing: ui.setUploadModalProcessing,
        uploadModalProcessingRequestId: ui.uploadModalProcessingRequestId,
        setUploadModalProcessingRequestId: ui.setUploadModalProcessingRequestId,
        uploadScanCount: ui.uploadScanCount,
        setUploadScanCount: ui.setUploadScanCount,
        uploadModalInitialEntries: ui.uploadModalInitialEntries,
        openUploadModalWithEntries: ui.openUploadModalWithEntries,
        clearUploadModalInitialEntries: ui.clearUploadModalInitialEntries,
        createFolderModalOpen: ui.createFolderModalOpen,
        setCreateFolderModalOpen: ui.setCreateFolderModalOpen,
        imageViewerFile: ui.imageViewerFile,
        setImageViewerFile: ui.setImageViewerFile,
        documentViewerFile: ui.documentViewerFile,
        setDocumentViewerFile: ui.setDocumentViewerFile,
        shareLinkModalOpen: ui.shareLinkModalOpen,
        shareLinks: ui.shareLinks,
        setShareLinkModalOpen: ui.setShareLinkModalOpen,
        renameTarget: ui.renameTarget,
        setRenameTarget: ui.setRenameTarget,

        // File operations
        createFolder: operations.createFolder,
        moveFiles: operations.moveFiles,
        copyFiles: operations.copyFiles,
        renameFile: operations.renameFile,
        shareFiles: operations.shareFiles,
        getShareLinks: operations.getShareLinks,
        linkToParentShare: operations.linkToParentShare,
        starFiles: operations.starFiles,
        deleteFiles: operations.deleteFiles,
        restoreFiles: operations.restoreFiles,
        deleteForever: operations.deleteForever,
        emptyTrash: operations.emptyTrash,
        isDeleting: operations.isDeleting,
        isRestoring: operations.isRestoring,
        deleteProgress: operations.deleteProgress,
        restoreProgress: operations.restoreProgress,

        // Clipboard
        clipboard: clipboard.clipboard,
        setClipboard: clipboard.setClipboard,
        clipboardCopy: clipboard.clipboardCopy,
        clipboardPaste: clipboard.clipboardPaste,
        pasteProgress: clipboard.pasteProgress,
        setPasteProgress: clipboard.setPasteProgress,

        // Uploads
        uploadFile: uploads.uploadFile,
        uploadFilesBulk: uploads.uploadFilesBulk,
        uploadEntriesBulk: uploads.uploadEntriesBulk,
        uploadFileWithProgress: uploads.uploadFileWithProgress,
        replaceFileWithProgress: uploads.replaceFileWithProgress,
        uploadProgress: uploads.uploadProgress,
        setUploadProgress: uploads.setUploadProgress,
        cancelUpload: uploads.cancelUpload,
        cancelUploadGroup: uploads.cancelUploadGroup,
        uploadFailures: uploads.uploadFailures,
        uploadSavedCount: uploads.uploadSavedCount,
        dismissUploadFailures: uploads.dismissUploadFailures,
        setIsUploadProgressInteracting: uploads.setIsUploadProgressInteracting,

        // Downloads
        isDownloading: downloads.isDownloading,
        downloadFiles: downloads.downloadFiles,
        downloadProgress: downloads.downloadProgress,
        cancelDownload: downloads.cancelDownload,
        dismissDownload: downloads.dismissDownload,
        setIsDownloadProgressInteracting: downloads.setIsDownloadProgressInteracting,

        // Desktop edit (Electron)
        editFileWithDesktop: desktopEdit.editFileWithDesktop,
        desktopOpenProgress: desktopEdit.desktopOpenProgress,
        setDesktopOpenProgress: desktopEdit.setDesktopOpenProgress,

        // Config
        onlyOfficeConfigured: config.onlyOfficeConfigured,
        canConfigureOnlyOffice: config.canConfigureOnlyOffice,
        refreshOnlyOfficeConfig: config.refreshOnlyOfficeConfig,
        hideFileExtensions: config.hideFileExtensions,
        setHideFileExtensions: config.setHideFileExtensions,

        // Updates
        updatesAvailable: updates.updatesAvailable,
        electronAutoUpdateState: updates.electronAutoUpdateState,
        retryElectronUpdate: updates.retryElectronUpdate,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
