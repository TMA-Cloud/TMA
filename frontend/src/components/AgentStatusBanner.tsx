import React from "react";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { checkAgentStatus, refreshAgentConnection } from "../utils/api";
import { useToast } from "../hooks/useToast";
import { getErrorMessage } from "../utils/errorUtils";
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
      const response = await checkAgentStatus();
      onStatusChange(response.isOnline);
    } catch {
      onStatusChange(false);
    }
  }, [onStatusChange]);

  const handleRefresh = async () => {
    try {
      setIsRefreshing(true);
      const response = await refreshAgentConnection();
      onStatusChange(response.isOnline);
      if (response.isOnline) {
        showToast("Agent connection restored", "success");
        setDismissed(false); // Re-enable banner if it comes back online then goes offline again
      } else {
        showToast("Agent is still offline", "error");
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
