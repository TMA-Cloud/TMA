import { useState, useEffect } from "react";
import { getSignupStatus, toggleSignup } from "../../../utils/api";
import { useToast } from "../../../hooks/useToast";

export function useSignupStatus() {
  const { showToast } = useToast();
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [canToggleSignup, setCanToggleSignup] = useState(false);
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [additionalUsers, setAdditionalUsers] = useState<number | null>(null);
  const [loadingSignupStatus, setLoadingSignupStatus] = useState(true);
  const [togglingSignup, setTogglingSignup] = useState(false);

  const loadSignupStatus = async () => {
    try {
      setLoadingSignupStatus(true);
      const status = await getSignupStatus();
      setSignupEnabled(status.signupEnabled);
      setCanToggleSignup(status.canToggle);
      setTotalUsers(
        typeof status.totalUsers === "number" ? status.totalUsers : null,
      );
      setAdditionalUsers(
        typeof status.additionalUsers === "number"
          ? status.additionalUsers
          : null,
      );
    } catch {
      // Error handled silently - signup toggle will be unavailable
    } finally {
      setLoadingSignupStatus(false);
    }
  };

  const handleToggleSignup = async () => {
    if (!canToggleSignup || togglingSignup) return;

    try {
      setTogglingSignup(true);
      const newStatus = !signupEnabled;
      await toggleSignup(newStatus);
      setSignupEnabled(newStatus);
      showToast(
        newStatus ? "Signup enabled" : "Signup disabled",
        newStatus ? "success" : "info",
      );
    } catch {
      // Error handled by toast notification
      showToast("Failed to update signup setting", "error");
    } finally {
      setTogglingSignup(false);
    }
  };

  useEffect(() => {
    loadSignupStatus();
  }, []);

  return {
    signupEnabled,
    canToggleSignup,
    totalUsers,
    additionalUsers,
    loadingSignupStatus,
    togglingSignup,
    handleToggleSignup,
    loadSignupStatus,
  };
}
