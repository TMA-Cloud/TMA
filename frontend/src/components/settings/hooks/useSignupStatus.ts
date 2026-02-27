import { useState, useEffect } from 'react';
import {
  getSignupStatus,
  toggleSignup,
  updateHideFileExtensionsConfig,
  updateElectronOnlyAccessConfig,
} from '../../../utils/api';
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
  const [electronOnlyAccess, setElectronOnlyAccess] = useState(false);
  const [canToggleElectronOnlyAccess, setCanToggleElectronOnlyAccess] = useState(false);
  const [togglingElectronOnlyAccess, setTogglingElectronOnlyAccess] = useState(false);

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
      setElectronOnlyAccess(status.electronOnlyAccess === true);
      setCanToggleElectronOnlyAccess(status.canToggleElectronOnlyAccess === true);
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

  const handleToggleElectronOnlyAccess = async () => {
    if (!canToggleElectronOnlyAccess || togglingElectronOnlyAccess) return;

    try {
      setTogglingElectronOnlyAccess(true);
      const newEnabled = !electronOnlyAccess;
      const res = await updateElectronOnlyAccessConfig(newEnabled);
      const updated = res.electronOnlyAccess;
      setElectronOnlyAccess(updated);
      showToast(
        updated
          ? 'Web access disabled – this instance now requires the desktop app.'
          : 'Web access enabled – browsers can access the app again.',
        'success'
      );
    } catch {
      showToast('Failed to update desktop-only access setting', 'error');
    } finally {
      setTogglingElectronOnlyAccess(false);
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
    electronOnlyAccess,
    canToggleElectronOnlyAccess,
    togglingElectronOnlyAccess,
    handleToggleElectronOnlyAccess,
  };
}
