import React from "react";
import {
  Grid,
  List,
  FolderPlus,
  Trash2,
  Share2,
  Star,
  Download,
  Edit3,
  RotateCcw,
} from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { SortMenu } from "./SortMenu";

interface FileManagerToolbarProps {
  isMobile: boolean;
  viewMode: "grid" | "list";
  sortBy: string;
  sortOrder: "asc" | "desc";
  selectedFiles: string[];
  isTrashView: boolean;
  isSharedView: boolean;
  isStarredView: boolean;
  hasTrashFiles: boolean;
  canCreateFolder: boolean;
  allShared: boolean;
  allStarred: boolean;
  isDownloading: boolean;
  onViewModeChange: (mode: "grid" | "list") => void;
  onSortChange: (by: string, order: "asc" | "desc") => void;
  onCreateFolder: () => void;
  onShare: () => void;
  onStar: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
  onEmptyTrash: () => void;
}

export const FileManagerToolbar: React.FC<FileManagerToolbarProps> = ({
  isMobile,
  viewMode,
  sortBy,
  sortOrder,
  selectedFiles,
  isTrashView,
  isSharedView,
  isStarredView,
  hasTrashFiles,
  canCreateFolder,
  allShared,
  allStarred,
  isDownloading,
  onViewModeChange,
  onSortChange,
  onCreateFolder,
  onShare,
  onStar,
  onDownload,
  onRename,
  onDelete,
  onRestore,
  onDeleteForever,
  onEmptyTrash,
}) => {
  return (
    <div
      className={`flex items-center ${isMobile ? "justify-end w-full flex-wrap gap-2" : "space-x-2"}`}
    >
      {/* Action buttons - only show when files are selected, but not on Trash page */}
      {selectedFiles.length > 0 && !isTrashView && (
        <>
          {/* Hide "Add to Share" on Shared page */}
          {!isSharedView && (
            <Tooltip text={allShared ? "Remove from Shared" : "Add to Share"}>
              <button
                className={`p-2.5 rounded-xl transition-all duration-200 hover-lift ${
                  allShared
                    ? "text-green-600 dark:text-green-400 bg-green-50/80 dark:bg-green-900/30 shadow-md shadow-green-500/40 dark:shadow-green-400/30 ring-1 ring-green-500/20 dark:ring-green-400/20"
                    : "text-gray-500/80 dark:text-gray-400/80 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50/50 dark:hover:bg-green-900/20 shadow-lg shadow-green-500/30 dark:shadow-green-400/20 ring-1 ring-green-500/20 dark:ring-green-400/20"
                }`}
                onClick={onShare}
                aria-label={allShared ? "Remove from Shared" : "Add to Share"}
              >
                <Share2
                  className={`w-5 h-5 transition-all duration-200 icon-muted ${
                    allShared
                      ? "fill-green-600 dark:fill-green-400 opacity-100"
                      : ""
                  }`}
                />
              </button>
            </Tooltip>
          )}

          {/* Hide "Add to Starred" on Starred page */}
          {!isStarredView && (
            <Tooltip
              text={allStarred ? "Remove from Starred" : "Add to Starred"}
            >
              <button
                className={`p-2.5 rounded-xl transition-all duration-200 hover-lift ${
                  allStarred
                    ? "text-yellow-600 dark:text-yellow-400 bg-yellow-50/80 dark:bg-yellow-900/30 shadow-md shadow-yellow-500/40 dark:shadow-yellow-400/30 ring-1 ring-yellow-500/20 dark:ring-yellow-400/20"
                    : "text-gray-500/80 dark:text-gray-400/80 hover:text-yellow-600 dark:hover:text-yellow-400 hover:bg-yellow-50/50 dark:hover:bg-yellow-900/20 shadow-lg shadow-yellow-500/30 dark:shadow-yellow-400/20 ring-1 ring-yellow-500/20 dark:ring-yellow-400/20"
                }`}
                onClick={onStar}
                aria-label={
                  allStarred ? "Remove from Starred" : "Add to Starred"
                }
              >
                <Star
                  className={`w-5 h-5 transition-all duration-200 icon-muted ${
                    allStarred
                      ? "fill-yellow-600 dark:fill-yellow-400 opacity-100"
                      : ""
                  }`}
                />
              </button>
            </Tooltip>
          )}

          <Tooltip text="Download">
            <button
              className="p-2.5 rounded-xl text-gray-500/80 hover:text-blue-600 dark:text-gray-400/80 dark:hover:text-blue-400 transition-all duration-200 hover-lift hover:bg-blue-50/50 dark:hover:bg-blue-900/20 shadow-lg shadow-blue-500/30 dark:shadow-blue-400/20 ring-1 ring-blue-500/20 dark:ring-blue-400/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:ring-0"
              onClick={onDownload}
              disabled={isDownloading || selectedFiles.length === 0}
              aria-label="Download"
            >
              <Download className="w-5 h-5 transition-all duration-200 icon-muted" />
            </button>
          </Tooltip>

          <Tooltip text="Rename">
            <button
              className="p-2.5 rounded-xl text-gray-500/80 hover:text-purple-600 dark:text-gray-400/80 dark:hover:text-purple-400 transition-all duration-200 hover-lift hover:bg-purple-50/50 dark:hover:bg-purple-900/20 shadow-lg shadow-purple-500/30 dark:shadow-purple-400/20 ring-1 ring-purple-500/20 dark:ring-purple-400/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:ring-0"
              onClick={onRename}
              disabled={selectedFiles.length !== 1}
              aria-label="Rename"
            >
              <Edit3 className="w-5 h-5 transition-all duration-200 icon-muted" />
            </button>
          </Tooltip>

          <Tooltip text="Delete">
            <button
              className="p-2.5 rounded-xl text-gray-500/80 hover:text-red-600 dark:text-gray-400/80 dark:hover:text-red-400 transition-all duration-200 hover-lift hover:bg-red-50/50 dark:hover:bg-red-900/20 shadow-lg shadow-red-500/30 dark:shadow-red-400/20 ring-1 ring-red-500/20 dark:ring-red-400/20"
              onClick={onDelete}
              aria-label="Delete"
            >
              <Trash2 className="w-5 h-5 transition-all duration-200 icon-muted" />
            </button>
          </Tooltip>
        </>
      )}
      {isTrashView ? (
        // Trash page: show Restore and Delete Forever buttons when files are selected, Empty Trash when no files selected
        <>
          {selectedFiles.length > 0 && (
            <>
              <Tooltip text="Restore">
                <button
                  className="p-2.5 rounded-xl text-gray-500/80 hover:text-green-600 dark:text-gray-400/80 dark:hover:text-green-400 transition-all duration-200 hover-lift hover:bg-green-50/50 dark:hover:bg-green-900/20 shadow-lg shadow-green-500/20 dark:shadow-green-400/10"
                  onClick={onRestore}
                  aria-label="Restore"
                >
                  <RotateCcw className="w-5 h-5 transition-transform duration-200" />
                </button>
              </Tooltip>
              <Tooltip text="Delete Forever">
                <button
                  className="p-2.5 rounded-xl text-gray-500/80 hover:text-red-600 dark:text-gray-400/80 dark:hover:text-red-400 transition-all duration-200 hover-lift hover:bg-red-50/50 dark:hover:bg-red-900/20 shadow-lg shadow-red-500/30 dark:shadow-red-400/20 ring-1 ring-red-500/20 dark:ring-red-400/20"
                  onClick={onDeleteForever}
                  aria-label="Delete Forever"
                >
                  <Trash2 className="w-5 h-5 transition-transform duration-200" />
                </button>
              </Tooltip>
            </>
          )}
          {hasTrashFiles && selectedFiles.length === 0 && (
            <Tooltip text="Empty Trash">
              <button
                className="p-2.5 rounded-xl text-gray-500/80 hover:text-red-600 dark:text-gray-400/80 dark:hover:text-red-400 transition-all duration-200 hover-lift hover:bg-red-50/50 dark:hover:bg-red-900/20"
                onClick={onEmptyTrash}
                aria-label="Empty Trash"
              >
                <Trash2 className="w-5 h-5 transition-transform duration-300" />
              </button>
            </Tooltip>
          )}
        </>
      ) : (
        // Other pages: show all buttons
        <>
          <Tooltip text="Grid view">
            <button
              onClick={() => onViewModeChange("grid")}
              className={`
                    p-2.5 rounded-xl transition-all duration-200 ease-out hover-lift
                    ${
                      viewMode === "grid"
                        ? "bg-blue-100/80 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 shadow-md"
                        : "text-gray-500/80 hover:text-blue-600 dark:text-gray-400/80 dark:hover:text-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/20"
                    }
                  `}
              aria-label="Grid view"
            >
              <Grid className="w-5 h-5 transition-transform duration-200" />
            </button>
          </Tooltip>

          <Tooltip text="List view">
            <button
              onClick={() => onViewModeChange("list")}
              className={`
                    p-2.5 rounded-xl transition-all duration-200 ease-out hover-lift
                    ${
                      viewMode === "list"
                        ? "bg-blue-100/80 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 shadow-md"
                        : "text-gray-500/80 hover:text-blue-600 dark:text-gray-400/80 dark:hover:text-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/20"
                    }
                  `}
              aria-label="List view"
            >
              <List className="w-5 h-5 transition-transform duration-200" />
            </button>
          </Tooltip>

          {canCreateFolder && (
            <Tooltip text="Create folder">
              <button
                className="p-2.5 rounded-xl text-gray-500/80 hover:text-green-600 dark:text-gray-400/80 dark:hover:text-green-400 transition-all duration-200 hover-lift hover:bg-green-50/50 dark:hover:bg-green-900/20"
                onClick={onCreateFolder}
                aria-label="Create folder"
              >
                <FolderPlus className="w-5 h-5 transition-transform duration-200" />
              </button>
            </Tooltip>
          )}

          <SortMenu
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={onSortChange}
          />
        </>
      )}
    </div>
  );
};
