import React from "react";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { checkMyAgentStatus, refreshAgentConnection } from "../utils/api";
import { useToast } from "../hooks/useToast";
import { getErrorMessage, ApiError } from "../utils/errorUtils";
import { useApp } from "../contexts/AppContext";

interface AgentStatusBannerProps {
  onStatusChange: (isOnline: boolean) => void;
}

export const AgentStatusBanner: React.FC<AgentStatusBannerProps> = ({
  onStatusChange,
}) => {
  const { showToast } = useToast();
  const { agentOnline, customDriveEnabled } = useApp();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  const checkStatus = React.useCallback(async () => {
    try {
      // Use non-admin endpoint that works for all users
      const response = await checkMyAgentStatus();
      // CRITICAL: Only set to true if explicitly true, otherwise set to false
      // This prevents false positives where backend might return incorrect status
      const isOnline = response.isOnline === true;
      onStatusChange(isOnline);
    } catch {
      // On error, assume offline to be safe
      onStatusChange(false);
    }
  }, [onStatusChange]);

  const handleRefresh = async () => {
    try {
      setIsRefreshing(true);
      // Store previous status to detect if it actually changed
      const previousStatus = agentOnline;

      // Try admin refresh endpoint first (if user is admin)
      try {
        const response = await refreshAgentConnection();
        const newStatus = response.isOnline;
        onStatusChange(newStatus);

        // Only show success if status actually changed from offline to online
        if (newStatus && previousStatus === false) {
          showToast("Agent connection restored", "success");
          setDismissed(false);
        } else if (!newStatus) {
          showToast("Agent is still offline", "error");
        }
        // If already online, no message needed
      } catch (adminError: unknown) {
        // If admin endpoint fails (403 for non-admin), just re-check status
        const isForbidden =
          adminError instanceof ApiError && adminError.status === 403;
        if (isForbidden) {
          // For non-admin users, we can only check status, not actually refresh
          // Check the current agent status and provide accurate feedback
          try {
            const response = await checkMyAgentStatus();
            // CRITICAL: Only treat as online if explicitly true
            const newStatus = response.isOnline === true;

            // Update the status
            onStatusChange(newStatus);

            // Provide accurate feedback based on actual status
            if (newStatus) {
              // Agent is online - show appropriate message only if status changed
              if (previousStatus === false) {
                // Status changed from offline to online
                showToast("Agent is online", "success");
                setDismissed(false);
              }
              // If already online, no message needed
            } else {
              // Agent is still offline - always show error
              showToast("Agent is still offline", "error");
            }
          } catch {
            // If status check fails, assume still offline
            onStatusChange(false);
            showToast("Agent is still offline", "error");
          }
        } else {
          throw adminError;
        }
      }
    } catch (error) {
      showToast(getErrorMessage(error, "Failed to refresh agent"), "error");
      onStatusChange(false);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Check status on mount only - no auto-retry
  React.useEffect(() => {
    checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount

  // Don't show if custom drive is not enabled, agent is online, unknown, or dismissed
  if (!customDriveEnabled || agentOnline !== false || dismissed) {
    return null;
  }

  return (
    <div className="bg-red-600 text-white px-4 py-3 flex items-center justify-between shadow-lg z-50">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 flex-shrink-0" />
        <div>
          <p className="font-semibold">Agent is offline</p>
          <p className="text-sm text-red-100">
            File operations are disabled. Please refresh agent connection.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="px-4 py-2 bg-white text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 font-medium"
        >
          <RefreshCw
            className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="p-2 hover:bg-red-700 rounded-lg transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};
