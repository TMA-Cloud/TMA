import { useState, useEffect, useCallback } from "react";
import {
  getAllUsersCustomDriveSettings,
  updateCustomDriveSettings,
  type UserCustomDriveInfo,
} from "../../../utils/api";
import { useToast } from "../../../hooks/useToast";

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

  const loadAllUsersCustomDrive = useCallback(async () => {
    try {
      setLoadingAllUsersCustomDrive(true);
      const { users } = await getAllUsersCustomDriveSettings();
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
      console.error("Failed to load all users custom drive settings:", error);
      showToast("Failed to load users' custom drive settings", "error");
    } finally {
      setLoadingAllUsersCustomDrive(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (canToggleSignup) {
      loadAllUsersCustomDrive();
    }
  }, [canToggleSignup, loadAllUsersCustomDrive]);

  const handleUpdateUserCustomDrive = async (
    userId: string,
    enabled: boolean,
    path: string | null,
  ): Promise<boolean> => {
    if (updatingUserCustomDrive) return false;

    try {
      setUpdatingUserCustomDrive(userId);
      await updateCustomDriveSettings(enabled, path, userId);
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
      // Reload all users' settings to sync with server
      await loadAllUsersCustomDrive();
      return true;
    } catch (error) {
      console.error("Failed to update user custom drive settings:", error);
      let errorMessage = "Failed to update custom drive settings";
      if (error instanceof Error) {
        errorMessage = error.message;
      }
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
