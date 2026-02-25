import { useState, useEffect } from 'react';
import { getSignupStatus, toggleSignup, updateHideFileExtensionsConfig } from '../../../utils/api';
import { useToast } from '../../../hooks/useToast';

export interface UseSignupStatusOptions {
  /** Called after hide file extensions setting is updated (e.g. to sync AppContext) */
  onHideFileExtensionsChange?: (hidden: boolean) => void;
}

export function useSignupStatus(options: UseSignupStatusOptions = {}) {
  const { onHideFileExtensionsChange } = options;
  const { showToast } = useToast();
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [canToggleSignup, setCanToggleSignup] = useState(false);
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [additionalUsers, setAdditionalUsers] = useState<number | null>(null);
  const [loadingSignupStatus, setLoadingSignupStatus] = useState(true);
  const [togglingSignup, setTogglingSignup] = useState(false);
  const [hideFileExtensions, setHideFileExtensions] = useState(false);
  const [canToggleHideFileExtensions, setCanToggleHideFileExtensions] = useState(false);
  const [togglingHideFileExtensions, setTogglingHideFileExtensions] = useState(false);

  const loadSignupStatus = async () => {
    try {
      setLoadingSignupStatus(true);
      const status = await getSignupStatus();
      setSignupEnabled(status.signupEnabled);
      setCanToggleSignup(status.canToggle);
      setTotalUsers(typeof status.totalUsers === 'number' ? status.totalUsers : null);
      setAdditionalUsers(typeof status.additionalUsers === 'number' ? status.additionalUsers : null);
      setHideFileExtensions(status.hideFileExtensions === true);
      setCanToggleHideFileExtensions(status.canToggleHideFileExtensions === true);
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
      showToast(newStatus ? 'Signup enabled' : 'Signup disabled', newStatus ? 'success' : 'info');
    } catch {
      // Error handled by toast notification
      showToast('Failed to update signup setting', 'error');
    } finally {
      setTogglingSignup(false);
    }
  };

  const handleToggleHideFileExtensions = async () => {
    if (!canToggleHideFileExtensions || togglingHideFileExtensions) return;

    try {
      setTogglingHideFileExtensions(true);
      const newHidden = !hideFileExtensions;
      const res = await updateHideFileExtensionsConfig(newHidden);
      const updated = res.hideFileExtensions;
      setHideFileExtensions(updated);
      onHideFileExtensionsChange?.(updated);
      showToast(updated ? 'File extensions hidden' : 'File extensions visible', 'success');
    } catch {
      showToast('Failed to update hide file extensions setting', 'error');
    } finally {
      setTogglingHideFileExtensions(false);
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
    hideFileExtensions,
    canToggleHideFileExtensions,
    togglingHideFileExtensions,
    handleToggleHideFileExtensions,
  };
}
