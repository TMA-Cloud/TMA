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
                className={`p-2 rounded-xl shadow-lg transition-all duration-300 hover:scale-110 active:scale-95 hover:shadow-xl ring-2 ring-green-400/50 dark:ring-green-500/50 ${
                  allShared
                    ? "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 shadow-green-500/30 dark:shadow-green-400/20"
                    : "text-gray-500 hover:text-green-600 dark:text-gray-400 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 shadow-green-500/20 dark:shadow-green-400/10"
                }`}
                style={{
                  animation: "actionGlowGreen 2s ease-in-out infinite",
                }}
                onClick={onShare}
                aria-label={allShared ? "Remove from Shared" : "Add to Share"}
              >
                <Share2
                  className={`w-5 h-5 transition-transform duration-300 ${
                    allShared ? "fill-green-600 dark:fill-green-400" : ""
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
                className={`p-2 rounded-xl shadow-lg transition-all duration-300 hover:scale-110 active:scale-95 hover:shadow-xl ring-2 ring-yellow-400/50 dark:ring-yellow-500/50 ${
                  allStarred
                    ? "text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 shadow-yellow-500/30 dark:shadow-yellow-400/20"
                    : "text-gray-500 hover:text-yellow-600 dark:text-gray-400 dark:hover:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 shadow-yellow-500/20 dark:shadow-yellow-400/10"
                }`}
                style={{
                  animation: "actionGlowYellow 2s ease-in-out infinite",
                }}
                onClick={onStar}
                aria-label={
                  allStarred ? "Remove from Starred" : "Add to Starred"
                }
              >
                <Star
                  className={`w-5 h-5 transition-transform duration-300 ${
                    allStarred ? "fill-yellow-600 dark:fill-yellow-400" : ""
                  }`}
                />
              </button>
            </Tooltip>
          )}

          <Tooltip text="Download">
            <button
              className="p-2 rounded-xl text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 shadow-lg transition-all duration-300 hover:scale-110 active:scale-95 hover:shadow-xl ring-2 ring-blue-400/50 dark:ring-blue-500/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                animation: "actionGlowBlue 2s ease-in-out infinite",
              }}
              onClick={onDownload}
              disabled={isDownloading || selectedFiles.length === 0}
              aria-label="Download"
            >
              <Download className="w-5 h-5 transition-transform duration-300" />
            </button>
          </Tooltip>

          <Tooltip text="Rename">
            <button
              className="p-2 rounded-xl text-gray-500 hover:text-purple-600 dark:text-gray-400 dark:hover:text-purple-400 shadow-lg transition-all duration-300 hover:scale-110 active:scale-95 hover:shadow-xl ring-2 ring-purple-400/50 dark:ring-purple-500/50 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                animation: "actionGlowPurple 2s ease-in-out infinite",
              }}
              onClick={onRename}
              disabled={selectedFiles.length !== 1}
              aria-label="Rename"
            >
              <Edit3 className="w-5 h-5 transition-transform duration-300" />
            </button>
          </Tooltip>

          <Tooltip text="Delete">
            <button
              className="p-2 rounded-xl text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 shadow-lg transition-all duration-300 hover:scale-110 active:scale-95 hover:shadow-xl ring-2 ring-red-400/50 dark:ring-red-500/50 hover:bg-red-50 dark:hover:bg-red-900/20"
              style={{
                animation: "actionGlowRed 2s ease-in-out infinite",
              }}
              onClick={onDelete}
              aria-label="Delete"
            >
              <Trash2 className="w-5 h-5 transition-transform duration-300" />
            </button>
          </Tooltip>
        </>
      )}
      {isTrashView ? (
        // Trash page: show Delete Forever button when files are selected, Empty Trash when no files selected
        <>
          {selectedFiles.length > 0 && (
            <Tooltip text="Delete Forever">
              <button
                className="p-2 rounded-xl text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 shadow-lg transition-all duration-300 hover:scale-110 active:scale-95 hover:shadow-xl ring-2 ring-red-400/50 dark:ring-red-500/50 hover:bg-red-50 dark:hover:bg-red-900/20"
                style={{
                  animation: "actionGlowRed 2s ease-in-out infinite",
                }}
                onClick={onDeleteForever}
                aria-label="Delete Forever"
              >
                <Trash2 className="w-5 h-5 transition-transform duration-300" />
              </button>
            </Tooltip>
          )}
          {hasTrashFiles && selectedFiles.length === 0 && (
            <Tooltip text="Empty Trash">
              <button
                className="p-2 rounded-xl text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 shadow-sm transition-all duration-300 hover:scale-110 active:scale-95 hover:bg-red-50 dark:hover:bg-red-900/20 hover:shadow-md"
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
                    p-2 rounded-xl transition-all duration-300 ease-out shadow-sm
                    hover:scale-110 active:scale-95
                    ${
                      viewMode === "grid"
                        ? "bg-blue-100 text-blue-600 dark:bg-blue-900/60 dark:text-blue-400 shadow-lg scale-105"
                        : "text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    }
                  `}
              aria-label="Grid view"
            >
              <Grid className="w-5 h-5 transition-transform duration-300" />
            </button>
          </Tooltip>

          <Tooltip text="List view">
            <button
              onClick={() => onViewModeChange("list")}
              className={`
                    p-2 rounded-xl transition-all duration-300 ease-out shadow-sm
                    hover:scale-110 active:scale-95
                    ${
                      viewMode === "list"
                        ? "bg-blue-100 text-blue-600 dark:bg-blue-900/60 dark:text-blue-400 shadow-lg scale-105"
                        : "text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    }
                  `}
              aria-label="List view"
            >
              <List className="w-5 h-5 transition-transform duration-300" />
            </button>
          </Tooltip>

          {canCreateFolder && (
            <Tooltip text="Create folder">
              <button
                className="p-2 rounded-xl text-gray-500 hover:text-green-600 dark:text-gray-400 dark:hover:text-green-400 shadow-sm transition-all duration-300 hover:scale-110 active:scale-95 hover:bg-green-50 dark:hover:bg-green-900/20 hover:shadow-md"
                onClick={onCreateFolder}
                aria-label="Create folder"
              >
                <FolderPlus className="w-5 h-5 transition-transform duration-300" />
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
