import React, { useState, useEffect, useRef } from "react";
import {
  Upload,
  X,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { formatFileSize } from "../../utils/fileUtils";

interface UploadProgressItem {
  id: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: "uploading" | "completed" | "error";
}

interface UploadProgressProps {
  uploads: UploadProgressItem[];
  onDismiss: (id: string) => void;
  onInteractionChange?: (isInteracting: boolean) => void;
}

const MAX_INDIVIDUAL_ITEMS = 2; // Show individual cards for 1-2 files
const MAX_VISIBLE_IN_EXPANDED = 5; // Max items to show in expanded view

export const UploadProgress: React.FC<UploadProgressProps> = ({
  uploads,
  onDismiss,
  onInteractionChange,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track user interaction - only active interactions count
  useEffect(() => {
    // Only consider it interacting if user is actively doing something
    // (hovering or scrolling)
    const isInteracting = isHovered || isScrolling;
    onInteractionChange?.(isInteracting);
  }, [isHovered, isScrolling, onInteractionChange]);

  // Handle scroll detection
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isExpanded) {
      return;
    }

    const handleScroll = () => {
      setIsScrolling(true);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      // When user stops scrolling, wait 1 second then mark as not scrolling
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 1000); // Consider user stopped scrolling after 1 second
    };

    // Also detect mouse movement over the scrollable area
    const handleMouseMove = () => {
      setIsScrolling(true);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 1000);
    };

    container.addEventListener("scroll", handleScroll);
    container.addEventListener("mousemove", handleMouseMove);
    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener("mousemove", handleMouseMove);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [isExpanded]);

  if (uploads.length === 0) return null;

  // Group uploads by status
  const uploading = uploads.filter((u) => u.status === "uploading");
  const completed = uploads.filter((u) => u.status === "completed");
  const errors = uploads.filter((u) => u.status === "error");

  // Calculate overall progress
  const totalProgress =
    uploading.length > 0
      ? Math.round(
          uploading.reduce((sum, u) => sum + u.progress, 0) / uploading.length,
        )
      : 100;

  // Show individual cards for 1-2 files
  if (uploads.length <= MAX_INDIVIDUAL_ITEMS) {
    return (
      <div
        className="fixed bottom-4 right-4 z-50 w-96 space-y-2"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {uploads.map((upload, index) => (
          <div
            key={upload.id}
            className="bg-white dark:bg-gray-900 border border-gray-200/50 dark:border-gray-700/50 rounded-xl shadow-xl backdrop-blur-xl p-4 transition-all duration-300 ease-out animate-fadeIn hover:shadow-2xl"
            style={{
              animationDelay: `${index * 50}ms`,
              transform: "translateY(0)",
            }}
          >
            <div className="flex items-center space-x-3">
              <div className="flex-shrink-0">
                {upload.status === "completed" ? (
                  <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
                  </div>
                ) : upload.status === "error" ? (
                  <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
                  </div>
                ) : (
                  <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <Upload className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-pulse" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {upload.fileName}
                </p>
                <div className="flex items-center justify-between mt-0.5">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatFileSize(upload.fileSize)}
                  </p>
                  {upload.status === "uploading" && (
                    <p className="text-xs font-medium text-blue-600 dark:text-blue-400">
                      {upload.progress}%
                    </p>
                  )}
                </div>

                {upload.status === "uploading" && (
                  <div className="mt-2.5">
                    <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-blue-500 to-blue-600 h-1.5 rounded-full transition-all duration-500 ease-out shadow-sm"
                        style={{ width: `${upload.progress}%` }}
                      />
                    </div>
                  </div>
                )}

                {upload.status === "completed" && (
                  <p className="text-xs font-medium text-green-600 dark:text-green-400 mt-1.5">
                    Completed
                  </p>
                )}

                {upload.status === "error" && (
                  <p className="text-xs font-medium text-red-600 dark:text-red-400 mt-1.5">
                    Failed
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Show summary card for 3+ files
  const visibleItems = isExpanded
    ? uploads.slice(0, MAX_VISIBLE_IN_EXPANDED)
    : [];
  const remainingCount = uploads.length - visibleItems.length;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 w-96"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        // Clear hover when mouse leaves - this allows auto-dismiss to work
        setIsHovered(false);
      }}
    >
      <div
        className="bg-white dark:bg-gray-900 border border-gray-200/50 dark:border-gray-700/50 rounded-xl shadow-xl backdrop-blur-xl transition-all duration-300 ease-out animate-fadeIn hover:shadow-2xl overflow-hidden"
        style={{
          transform: "translateY(0) scale(1)",
        }}
      >
        {/* Summary Header */}
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800/50 bg-gradient-to-r from-gray-50/50 to-transparent dark:from-gray-800/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <Upload className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">
                  {uploading.length > 0
                    ? `${uploading.length} uploading`
                    : completed.length > 0
                      ? `${completed.length} completed`
                      : `${errors.length} failed`}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {uploading.length > 0 && (
                    <span>
                      {completed.length > 0 && `${completed.length} completed`}
                      {completed.length > 0 && errors.length > 0 && " • "}
                      {errors.length > 0 && `${errors.length} failed`}
                    </span>
                  )}
                  {uploading.length === 0 && (
                    <span>
                      {completed.length > 0 && errors.length > 0 && " • "}
                      {errors.length > 0 && `${errors.length} failed`}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                // Dismiss all completed items
                completed.forEach((u) => onDismiss(u.id));
              }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200"
              title="Dismiss all completed"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {uploading.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Overall progress
                </p>
                <p className="text-xs font-bold text-blue-600 dark:text-blue-400">
                  {totalProgress}%
                </p>
              </div>
              <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-blue-600 h-2 rounded-full transition-all duration-500 ease-out shadow-sm"
                  style={{ width: `${totalProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Expandable List */}
        <div
          ref={containerRef}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => {
            // Clear hover when leaving the list area
            setIsHovered(false);
          }}
          className={`max-h-64 overflow-y-auto transition-all duration-300 ease-out ${
            isExpanded
              ? "opacity-100 max-h-64"
              : "opacity-0 max-h-0 overflow-hidden"
          }`}
        >
          {visibleItems.map((upload, index) => (
            <div
              key={upload.id}
              className="px-5 py-3 border-b border-gray-100 dark:border-gray-800/50 last:border-b-0 hover:bg-gray-50/50 dark:hover:bg-gray-800/30 transition-all duration-200 ease-out"
              style={{
                animationDelay: `${index * 30}ms`,
              }}
            >
              <div className="flex items-center space-x-3">
                <div className="flex-shrink-0">
                  {upload.status === "completed" ? (
                    <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                      <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                    </div>
                  ) : upload.status === "error" ? (
                    <div className="w-8 h-8 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                      <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                      <Upload className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-pulse" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {upload.fileName}
                  </p>
                  <div className="flex items-center justify-between mt-1">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {formatFileSize(upload.fileSize)}
                    </p>
                    {upload.status === "uploading" && (
                      <p className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                        {upload.progress}%
                      </p>
                    )}
                  </div>
                  {upload.status === "uploading" && (
                    <div className="mt-2">
                      <div className="bg-gray-100 dark:bg-gray-800 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-gradient-to-r from-blue-500 to-blue-600 h-1.5 rounded-full transition-all duration-500 ease-out"
                          style={{ width: `${upload.progress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {remainingCount > 0 && (
            <div className="px-5 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50/50 dark:bg-gray-800/30">
              +{remainingCount} more file{remainingCount !== 1 ? "s" : ""}
            </div>
          )}
        </div>

        {/* Expand/Collapse Button */}
        <button
          onClick={() => {
            setIsExpanded(!isExpanded);
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => {
            // Small delay before clearing hover to prevent flickering
            setTimeout(() => {
              setIsHovered(false);
            }, 100);
          }}
          className="w-full px-5 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-all duration-200 flex items-center justify-center space-x-2 border-t border-gray-100 dark:border-gray-800/50"
        >
          {isExpanded ? (
            <>
              <span>Show less</span>
              <ChevronUp className="w-4 h-4" />
            </>
          ) : (
            <>
              <span>
                Show {uploads.length} file{uploads.length !== 1 ? "s" : ""}
              </span>
              <ChevronDown className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
};
