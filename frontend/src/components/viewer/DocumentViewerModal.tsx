import React, { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { ONLYOFFICE_EXTS, getExt } from "../../utils/fileUtils";

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
  const documentViewerFile = appContext.documentViewerFile ?? null;
  const setDocumentViewerFile = appContext.setDocumentViewerFile;
  const refreshOnlyOfficeConfig = appContext.refreshOnlyOfficeConfig;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DocsAPIEditor | null>(null);
  const lastRefreshedFileIdRef = useRef<string | null>(null);

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

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // Fetch config first to get ONLYOFFICE JS URL
        const res = await fetch(
          `/api/onlyoffice/config/${documentViewerFile.id}`,
          {
            credentials: "include",
          },
        );
        if (!res.ok) {
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
        const errorMessage =
          e instanceof Error ? e.message : "Failed to open document";
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [documentViewerFile, refreshOnlyOfficeConfig]);

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
