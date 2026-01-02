import { useState, useEffect, useCallback, useRef } from "react";
import {
  getAllUsersCustomDriveSettings,
  updateCustomDriveSettings,
  type UserCustomDriveInfo,
} from "../../../utils/api";
import { useToast } from "../../../hooks/useToast";
import { useAuth } from "../../../contexts/AuthContext";
import { getErrorMessage } from "../../../utils/errorUtils";

export type UserCustomDriveLocalState = Record<
  string,
  {
    enabled: boolean;
    path: string;
    expanded: boolean;
    error: string | null;
  }
>;

export function useCustomDriveManagement(canToggleSignup: boolean) {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [allUsersCustomDrive, setAllUsersCustomDrive] = useState<
    UserCustomDriveInfo[]
  >([]);
  const [loadingAllUsersCustomDrive, setLoadingAllUsersCustomDrive] =
    useState(false);
  const [updatingUserCustomDrive, setUpdatingUserCustomDrive] = useState<
    string | null
  >(null);
  const [userCustomDriveLocalState, setUserCustomDriveLocalState] =
    useState<UserCustomDriveLocalState>({});
  const [confirmingUserId, setConfirmingUserId] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<
    "enable" | "disable" | null
  >(null);

  // Track if component should make API calls
  const shouldLoadRef = useRef(false);

  const loadAllUsersCustomDrive = useCallback(async () => {
    // Early return if should not load - prevents calls after logout
    if (!shouldLoadRef.current) {
      return;
    }

    try {
      setLoadingAllUsersCustomDrive(true);
      const { users } = await getAllUsersCustomDriveSettings();

      // Check again after async operation - user might have logged out
      if (!shouldLoadRef.current) {
        return;
      }

      setAllUsersCustomDrive(users);
      // Initialize local state for each user
      const initialState: UserCustomDriveLocalState = {};
      users.forEach((user) => {
        initialState[user.id] = {
          enabled: user.customDrive.enabled,
          path: user.customDrive.path || "",
          expanded: false,
          error: null,
        };
      });
      setUserCustomDriveLocalState(initialState);
    } catch (error) {
      // Don't show error toast for 401 (unauthorized) - expected after logout
      // Check for common 401 error messages
      const errorMessage = getErrorMessage(error, "").toLowerCase();
      if (
        errorMessage.includes("401") ||
        errorMessage.includes("unauthorized") ||
        errorMessage.includes("not authenticated")
      ) {
        return;
      }
      // Only show error if we should still be loading (user still authenticated)
      if (shouldLoadRef.current) {
        // Error handled by toast notification
        showToast("Failed to load users' custom drive settings", "error");
      }
    } finally {
      setLoadingAllUsersCustomDrive(false);
    }
  }, [showToast]);

  useEffect(() => {
    // Update ref based on current conditions
    const shouldLoad = canToggleSignup && !!user;
    shouldLoadRef.current = shouldLoad;

    // Only load if user is authenticated and has permission
    if (shouldLoad) {
      loadAllUsersCustomDrive();
    } else {
      // Clear data when user logs out or loses permission
      setAllUsersCustomDrive([]);
      setUserCustomDriveLocalState({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canToggleSignup, user]); // Intentionally exclude loadAllUsersCustomDrive to prevent unnecessary re-runs

  const handleUpdateUserCustomDrive = async (
    userId: string,
    enabled: boolean,
    path: string | null,
  ): Promise<boolean> => {
    // Prevent concurrent updates to avoid race conditions
    if (updatingUserCustomDrive) return false;

    // Check if user is still authenticated before proceeding
    if (!user || !shouldLoadRef.current) {
      return false;
    }

    try {
      setUpdatingUserCustomDrive(userId);
      await updateCustomDriveSettings(enabled, path, userId);

      // Check again after async operation - user might have logged out
      if (!shouldLoadRef.current) {
        return false;
      }

      showToast(
        enabled
          ? "Custom drive enabled for user"
          : "Custom drive disabled for user",
        "success",
      );
      // Update local state
      setUserCustomDriveLocalState((prev) => ({
        ...prev,
        [userId]: {
          enabled,
          path: path || "",
          expanded: false,
          error: null,
        },
      }));
      // Reload all users' settings to sync with server (only if still authenticated)
      if (shouldLoadRef.current) {
        await loadAllUsersCustomDrive();
      }
      return true;
    } catch (error) {
      // Error handled by toast notification
      const errorMessage = getErrorMessage(
        error,
        "Failed to update custom drive settings",
      );
      // Update error in local state
      setUserCustomDriveLocalState((prev) => ({
        ...prev,
        [userId]: {
          ...(prev[userId] || {
            enabled: false,
            path: "",
            expanded: false,
            error: null,
          }),
          error: errorMessage,
        },
      }));
      showToast(errorMessage, "error");
      return false;
    } finally {
      setUpdatingUserCustomDrive(null);
    }
  };

  const handleConfirmEnable = (userId: string) => {
    setConfirmingUserId(userId);
    setConfirmingAction("enable");
  };

  const handleConfirmDisable = (userId: string) => {
    setConfirmingUserId(userId);
    setConfirmingAction("disable");
  };

  const handleCancelConfirmation = () => {
    const userId = confirmingUserId;
    const userInfo = allUsersCustomDrive.find((u) => u.id === userId);
    setConfirmingUserId(null);
    setConfirmingAction(null);
    // Revert local state to actual server state when modal is closed without confirmation
    if (userInfo) {
      setUserCustomDriveLocalState((prev) => ({
        ...prev,
        [userId!]: {
          enabled: userInfo.customDrive.enabled,
          path: userInfo.customDrive.path || "",
          expanded: prev[userId!]?.expanded || false,
          error: null,
        },
      }));
    } else {
      // User not found in list - remove from local state to prevent UI/server mismatch
      setUserCustomDriveLocalState((prev) => {
        const newState = { ...prev };
        delete newState[userId!];
        return newState;
      });
    }
  };

  const handleProceedEnable = () => {
    const userId = confirmingUserId;
    const userInfo = allUsersCustomDrive.find((u) => u.id === userId);
    setConfirmingUserId(null);
    setConfirmingAction(null);
    // Expand for path configuration, but keep enabled state as server state until save succeeds
    setUserCustomDriveLocalState((prev) => ({
      ...prev,
      [userId!]: {
        enabled: userInfo?.customDrive.enabled || false,
        path: prev[userId!]?.path || "",
        expanded: true,
        error: null,
      },
    }));
  };

  const handleProceedDisable = async () => {
    const userId = confirmingUserId;
    setConfirmingUserId(null);
    setConfirmingAction(null);
    // Error handling is done in handleUpdateUserCustomDrive
    await handleUpdateUserCustomDrive(userId!, false, null);
  };

  return {
    allUsersCustomDrive,
    loadingAllUsersCustomDrive,
    updatingUserCustomDrive,
    userCustomDriveLocalState,
    setUserCustomDriveLocalState,
    confirmingUserId,
    confirmingAction,
    loadAllUsersCustomDrive,
    handleUpdateUserCustomDrive,
    handleConfirmEnable,
    handleConfirmDisable,
    handleCancelConfirmation,
    handleProceedEnable,
    handleProceedDisable,
  };
}
