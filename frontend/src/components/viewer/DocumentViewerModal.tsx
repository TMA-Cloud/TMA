import React, { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { useAuth } from "../../contexts/AuthContext";
import { ONLYOFFICE_EXTS, getExt } from "../../utils/fileUtils";
import { getErrorMessage, isAuthError } from "../../utils/errorUtils";
import { useToast } from "../../hooks/useToast";
import {
  isAgentOfflineError,
  isAgentOfflineResponse,
} from "../../utils/agentErrorHandler";

interface DocsAPIEditor {
  destroyEditor?: () => void;
}

interface DocsAPIConfig {
  document: {
    fileType: string;
    key: string;
    title: string;
    url: string;
    token?: string;
  };
  editorConfig: {
    callbackUrl: string;
    mode: "view" | "edit";
    lang: string;
    customization: {
      autosave: boolean;
    };
    user: {
      id: string;
      name: string;
    };
  };
  type: string;
  token?: string;
}

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (
        containerId: string,
        config: DocsAPIConfig,
      ) => DocsAPIEditor;
    };
  }
}

export const DocumentViewerModal: React.FC = () => {
  const appContext = useApp();
  const { user } = useAuth();
  const { showToast } = useToast();
  const documentViewerFile = appContext.documentViewerFile ?? null;
  const setDocumentViewerFile = appContext.setDocumentViewerFile;
  const refreshOnlyOfficeConfig = appContext.refreshOnlyOfficeConfig;
  const setAgentOnline = appContext.setAgentOnline;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DocsAPIEditor | null>(null);
  const lastRefreshedFileIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (editorRef.current && editorRef.current.destroyEditor) {
        editorRef.current.destroyEditor();
        editorRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!documentViewerFile) return;
    const ext = getExt(documentViewerFile.name);
    if (!ONLYOFFICE_EXTS.has(ext)) return;

    // Don't load if user is not authenticated
    if (!user) {
      return;
    }

    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const load = async () => {
      // Check if user is still authenticated before making the call
      if (!user) {
        abortController.abort();
        return;
      }

      // Check if request was aborted before making the call
      if (abortController.signal.aborted) {
        return;
      }

      setLoading(true);
      setError(null);
      try {
        // Fetch config first to get ONLYOFFICE JS URL
        const res = await fetch(
          `/api/onlyoffice/config/${documentViewerFile.id}`,
          {
            credentials: "include",
            signal: abortController.signal,
          },
        );

        // Check if request was aborted after fetch
        if (abortController.signal.aborted) {
          return;
        }

        if (!res.ok) {
          // Don't show error for authentication errors - expected after logout
          if (res.status === 401) {
            return;
          }

          if (res.status === 400) {
            // Check if it's an agent offline error
            try {
              const errorData = await res.json();
              const errorMessage =
                errorData.message ||
                errorData.error ||
                "Cannot open file. File type mismatch detected.";

              // Check if this is an agent offline error
              if (isAgentOfflineResponse(res.status, errorMessage)) {
                setAgentOnline(false);
                showToast(
                  "Agent is offline. Please refresh agent connection in Settings.",
                  "error",
                );
              } else {
                // MIME type validation failed - show toast and close modal
                showToast(errorMessage, "error");
              }
            } catch {
              // If JSON parsing fails, check status text
              const errorMessage =
                res.statusText ||
                "Cannot open file. File type mismatch detected.";
              if (isAgentOfflineResponse(res.status, errorMessage)) {
                setAgentOnline(false);
                showToast(
                  "Agent is offline. Please refresh agent connection in Settings.",
                  "error",
                );
              } else {
                showToast(
                  "Cannot open file. File type mismatch detected.",
                  "error",
                );
              }
            }
            setDocumentViewerFile?.(null);
            return;
          }

          if (res.status === 424 || res.status === 503) {
            // Refresh config status once per file when error occurs (gentle refresh)
            if (documentViewerFile.id !== lastRefreshedFileIdRef.current) {
              lastRefreshedFileIdRef.current = documentViewerFile.id;
              // Fire and forget - don't wait for it, just refresh the cache
              void refreshOnlyOfficeConfig();
            }
            throw new Error(
              "OnlyOffice not configured. Configure in Settings.",
            );
          }
          throw new Error("Failed to fetch ONLYOFFICE config");
        }
        const { config, token, onlyofficeJsUrl } = await res.json();

        // Load ONLYOFFICE JS if needed
        if (!window.DocsAPI) {
          const script = document.createElement("script");
          script.src = onlyofficeJsUrl;
          script.async = true;
          await new Promise<void>((resolve, reject) => {
            script.onload = () => resolve();
            script.onerror = () =>
              reject(new Error("Failed to load ONLYOFFICE API"));
            document.body.appendChild(script);
          });
        }

        if (token) config.token = token;

        // Render editor
        if (containerRef.current) {
          // Cleanup any previous instance
          containerRef.current.innerHTML = "";
        }
        if (!window.DocsAPI) {
          throw new Error("ONLYOFFICE API not loaded");
        }
        editorRef.current = new window.DocsAPI.DocEditor(
          "onlyoffice-editor-container",
          config,
        );
      } catch (e) {
        // Ignore abort errors (expected when cancelling requests)
        if (e instanceof Error && e.name === "AbortError") {
          return;
        }

        // Don't show error for authentication errors - expected after logout
        if (isAuthError(e)) {
          return;
        }

        // Check if it's an agent offline error
        const errorMessage = getErrorMessage(e, "Failed to open document");
        if (isAgentOfflineError(e) || isAgentOfflineResponse(0, errorMessage)) {
          setAgentOnline(false);
          showToast(
            "Agent is offline. Please refresh agent connection in Settings.",
            "error",
          );
          setDocumentViewerFile?.(null);
          return;
        }

        setError(errorMessage);
      } finally {
        // Only update loading state if this request wasn't aborted
        if (
          !abortController.signal.aborted &&
          abortControllerRef.current === abortController
        ) {
          setLoading(false);
          abortControllerRef.current = null;
        }
      }
    };

    void load();

    // Cleanup: abort request if component unmounts or file changes
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [
    documentViewerFile,
    refreshOnlyOfficeConfig,
    user,
    setDocumentViewerFile,
    showToast,
    setAgentOnline,
  ]);

  // Cancel any in-flight requests when user logs out
  useEffect(() => {
    if (!user) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    }
  }, [user]);

  if (!documentViewerFile) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-white dark:bg-gray-900 w-[95vw] h-[90vh] rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header bar with close button */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate flex-1 mr-4">
            {documentViewerFile.name}
          </h3>
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-2 rounded-md bg-blue-600 dark:bg-blue-500 text-white text-sm hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors flex items-center gap-2 flex-shrink-0"
              onClick={() => {
                const url = `/api/onlyoffice/viewer/${documentViewerFile.id}`;
                window.open(url, "_blank", "noopener,noreferrer");
                // Close the document in the main tab to avoid confusion when editing in the new tab
                setDocumentViewerFile?.(null);
              }}
              title="Open in new tab"
            >
              <ExternalLink className="w-4 h-4" />
              Open in Tab
            </button>
            <button
              className="px-4 py-2 rounded-md bg-red-600 dark:bg-red-500 text-white text-sm hover:bg-red-700 dark:hover:bg-red-600 transition-colors flex-shrink-0"
              onClick={() => setDocumentViewerFile?.(null)}
            >
              Close
            </button>
          </div>
        </div>

        {/* Editor container */}
        <div className="flex-1 relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900 z-20">
              <div className="text-gray-600 dark:text-gray-400">Loading…</div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-red-600 dark:text-red-400 z-20 bg-white dark:bg-gray-900">
              {error}
            </div>
          )}
          <div
            ref={containerRef}
            id="onlyoffice-editor-container"
            className="w-full h-full"
          />
        </div>
      </div>
    </div>
  );
};
