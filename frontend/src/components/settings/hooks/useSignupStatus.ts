import { useState, useEffect } from 'react';
import {
  getSignupStatus,
  toggleSignup,
  updateHideFileExtensionsConfig,
  updateElectronOnlyAccessConfig,
  updatePasswordChangeConfig,
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
  const [allowPasswordChange, setAllowPasswordChange] = useState(false);
  const [canToggleAllowPasswordChange, setCanToggleAllowPasswordChange] = useState(false);
  const [togglingAllowPasswordChange, setTogglingAllowPasswordChange] = useState(false);

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
      setAllowPasswordChange(status.allowPasswordChange === true);
      setCanToggleAllowPasswordChange(status.canToggleAllowPasswordChange === true);
    } catch {
      // Error handled silently - signup toggle will be unavailable
    } finally {
      setLoadingSignupStatus(false);
    }
  };

  const runToggle = async <T>(
    canToggle: boolean,
    busy: boolean,
    current: boolean,
    setBusy: (v: boolean) => void,
    call: (next: boolean) => Promise<T>,
    onSuccess: (result: T, next: boolean) => void,
    errorMsg: string
  ) => {
    if (!canToggle || busy) return;
    try {
      setBusy(true);
      const next = !current;
      const result = await call(next);
      onSuccess(result, next);
    } catch {
      showToast(errorMsg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleSignup = () =>
    runToggle(
      canToggleSignup,
      togglingSignup,
      signupEnabled,
      setTogglingSignup,
      next => toggleSignup(next),
      (_r, next) => {
        setSignupEnabled(next);
        showToast(next ? 'Signup enabled' : 'Signup disabled', next ? 'success' : 'info');
      },
      'Failed to update signup setting'
    );

  const handleToggleHideFileExtensions = () =>
    runToggle(
      canToggleHideFileExtensions,
      togglingHideFileExtensions,
      hideFileExtensions,
      setTogglingHideFileExtensions,
      next => updateHideFileExtensionsConfig(next),
      res => {
        const updated = res.hideFileExtensions;
        setHideFileExtensions(updated);
        onHideFileExtensionsChange?.(updated);
        showToast(updated ? 'File extensions hidden' : 'File extensions visible', 'success');
      },
      'Failed to update hide file extensions setting'
    );

  const handleToggleElectronOnlyAccess = () =>
    runToggle(
      canToggleElectronOnlyAccess,
      togglingElectronOnlyAccess,
      electronOnlyAccess,
      setTogglingElectronOnlyAccess,
      next => updateElectronOnlyAccessConfig(next),
      res => {
        const updated = res.electronOnlyAccess;
        setElectronOnlyAccess(updated);
        showToast(
          updated
            ? 'Web access disabled – this instance now requires the desktop app.'
            : 'Web access enabled – browsers can access the app again.',
          'success'
        );
      },
      'Failed to update desktop-only access setting'
    );

  const handleToggleAllowPasswordChange = () =>
    runToggle(
      canToggleAllowPasswordChange,
      togglingAllowPasswordChange,
      allowPasswordChange,
      setTogglingAllowPasswordChange,
      next => updatePasswordChangeConfig(next),
      res => {
        const updated = res.allowPasswordChange;
        setAllowPasswordChange(updated);
        showToast(
          updated ? 'Users can now change their passwords.' : 'Users can no longer change their passwords.',
          'success'
        );
      },
      'Failed to update password change setting'
    );

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
    allowPasswordChange,
    canToggleAllowPasswordChange,
    togglingAllowPasswordChange,
    handleToggleAllowPasswordChange,
  };
}
