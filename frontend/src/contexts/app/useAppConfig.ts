import { useCallback, useEffect, useState } from 'react';
import { checkOnlyOfficeConfigured, getSignupStatus, hasAuthState } from '../../utils/api';

/** Instance/admin config: ONLYOFFICE availability, toggle permission, hide-file-extensions. */
export function useAppConfig() {
  const [onlyOfficeConfigured, setOnlyOfficeConfigured] = useState(false);
  const [canConfigureOnlyOffice, setCanConfigureOnlyOffice] = useState(false);
  const [hideFileExtensions, setHideFileExtensions] = useState(false);

  const refreshOnlyOfficeConfig = useCallback(async () => {
    if (!hasAuthState()) {
      setOnlyOfficeConfigured(false);
      return;
    }
    try {
      const result = await checkOnlyOfficeConfigured();
      setOnlyOfficeConfigured(result.configured);
    } catch {
      setOnlyOfficeConfigured(false);
    }
  }, []);

  useEffect(() => {
    const loadAdminStatus = async () => {
      try {
        const status = await getSignupStatus();
        setCanConfigureOnlyOffice(status.canToggle);
        setHideFileExtensions(status.hideFileExtensions === true);
      } catch {
        setCanConfigureOnlyOffice(false);
      }
    };
    Promise.resolve().then(() => {
      void loadAdminStatus();
      void refreshOnlyOfficeConfig();
    });
  }, [refreshOnlyOfficeConfig]);

  return {
    onlyOfficeConfigured,
    canConfigureOnlyOffice,
    refreshOnlyOfficeConfig,
    hideFileExtensions,
    setHideFileExtensions,
  };
}
