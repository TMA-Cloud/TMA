import React, { useState, useCallback } from 'react';
import { FileText, Eye, EyeOff } from 'lucide-react';
import { useToast } from '../../../hooks/useToast';
import { useApp } from '../../../contexts/AppContext';
import { useAuth } from '../../../contexts/AuthContext';
import { getOnlyOfficeConfig, updateOnlyOfficeConfig } from '../../../utils/api';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { SettingsField, SettingsReadonlyValue, SettingsFormActions } from '../components/SettingsField';
import { ConfigSectionHeader } from '../components/ConfigSectionHeader';

interface OnlyOfficeSectionProps {
  canConfigure: boolean;
}

export const OnlyOfficeSection: React.FC<OnlyOfficeSectionProps> = ({ canConfigure }) => {
  const { showToast } = useToast();
  const { refreshOnlyOfficeConfig } = useApp();
  const { user } = useAuth();
  const [jwtSecret, setJwtSecret] = useState('');
  const [url, setUrl] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [jwtSecretSet, setJwtSecretSet] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false);
  const [showJwtSecret, setShowJwtSecret] = useState(false);

  const { loading } = useAbortableLoader({
    fetcher: getOnlyOfficeConfig,
    onSuccess: useCallback((config: { jwtSecretSet: boolean; url: string | null }) => {
      const urlValue = config.url || '';
      setJwtSecret('');
      setUrl(urlValue);
      setJwtSecretSet(config.jwtSecretSet);
      setOriginalUrl(urlValue);
      setIsEditing(false);
      setHasLoadedSettings(true);
      setIsCollapsed(true);
    }, []),
    errorMessage: 'Failed to load OnlyOffice settings',
    enabled: !!user && canConfigure,
  });

  const handleEdit = () => {
    if (isCollapsed) {
      // Expand and enter edit mode
      setIsCollapsed(false);
      setIsEditing(true);
      // JWT secret always starts empty in edit mode
      setJwtSecret('');
      setShowJwtSecret(false); // Reset to hidden by default
    } else if (isEditing) {
      // If editing, collapse and cancel
      setIsCollapsed(true);
      setIsEditing(false);
      setJwtSecret(''); // Clear JWT secret on cancel
      setUrl(originalUrl);
      setShowJwtSecret(false); // Reset to hidden
    } else {
      // If expanded but not editing, enter edit mode
      setIsEditing(true);
      // JWT secret always starts empty in edit mode
      setJwtSecret('');
      setShowJwtSecret(false); // Reset to hidden by default
    }
  };

  const handleCancel = () => {
    setJwtSecret(''); // Clear JWT secret on cancel
    setUrl(originalUrl);
    setIsEditing(false);
    setIsCollapsed(true);
  };

  const saveAction = useCallback(
    async (nextJwt: string, nextUrl: string) => {
      // Backend handles validation (trimming, URL format, both-or-none rule)
      const response = await updateOnlyOfficeConfig(nextJwt || null, nextUrl || null);
      const savedUrl = response.url || '';
      // Never store JWT secret - always clear after save
      setJwtSecret('');
      setUrl(savedUrl);
      setJwtSecretSet(response.jwtSecretSet);
      setOriginalUrl(savedUrl);
      setHasLoadedSettings(true);
      setIsEditing(false);
      setIsCollapsed(true);

      // Refresh OnlyOffice config cache in app context (non-critical)
      try {
        await refreshOnlyOfficeConfig();
      } catch {
        // Error handled silently - cache refresh is non-critical
      }

      showToast(response.jwtSecretSet && savedUrl ? 'Settings saved' : 'Settings cleared', 'success');
    },
    [refreshOnlyOfficeConfig, showToast]
  );
  const { run: runSave, busy: saving } = useAsyncAction(saveAction, {
    errorMessage: 'Failed to save OnlyOffice settings',
  });

  const handleSave = () => {
    if (!canConfigure) return;
    runSave(jwtSecret, url);
  };

  if (!canConfigure) {
    return null;
  }

  // Configured only when both the URL exists and the JWT secret is set.
  const isConfigured = !!originalUrl && jwtSecretSet;

  return (
    <div className="relative">
      <ConfigSectionHeader
        icon={FileText}
        title="OnlyOffice Integration"
        description="Configure OnlyOffice Document Server for document editing and viewing"
        isConfigured={isConfigured}
        loading={loading}
        saving={saving}
        isCollapsed={isCollapsed}
        isEditing={isEditing}
        hasLoadedSettings={hasLoadedSettings}
        editLabel="OnlyOffice settings"
        onEdit={handleEdit}
      />

      {!isCollapsed && (
        <form autoComplete="off" onSubmit={e => e.preventDefault()}>
          {/* Hidden dummy fields to distract password managers */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            style={{
              position: 'absolute',
              left: '-9999px',
              opacity: 0,
              pointerEvents: 'none',
            }}
            tabIndex={-1}
            readOnly
          />
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            style={{
              position: 'absolute',
              left: '-9999px',
              opacity: 0,
              pointerEvents: 'none',
            }}
            tabIndex={-1}
            readOnly
          />
          <div className="space-y-4">
            {isEditing ? (
              <>
                {isConfigured && (
                  <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 px-4 py-3 border border-blue-200 dark:border-blue-800">
                    <p className="text-sm text-blue-700 dark:text-blue-300">
                      To update, re-enter both URL and JWT secret or to unset, clear both fields
                    </p>
                  </div>
                )}
                <SettingsField
                  htmlFor="onlyoffice-url"
                  label="OnlyOffice Document Server URL"
                  description="Base URL of your OnlyOffice Document Server"
                >
                  <input
                    id="onlyoffice-url"
                    type="text"
                    name="x-server-url-config"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    disabled={loading || saving}
                    placeholder="http://documentserver.example.com"
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    data-bwignore="true"
                    data-form-type="other"
                    className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </SettingsField>

                <SettingsField
                  htmlFor="onlyoffice-jwt-secret"
                  label="JWT Secret"
                  description="Secret key for signing OnlyOffice requests"
                >
                  <div className="relative">
                    <input
                      id="onlyoffice-jwt-secret"
                      type="text"
                      name="x-jwt-token-config"
                      value={showJwtSecret ? jwtSecret : '•'.repeat(jwtSecret.length || 0)}
                      onChange={e => {
                        if (showJwtSecret) {
                          setJwtSecret(e.target.value);
                        } else {
                          // When masked, show on first input
                          setShowJwtSecret(true);
                          setJwtSecret(e.target.value.replace(/•/g, ''));
                        }
                      }}
                      onFocus={() => {
                        if (!showJwtSecret && jwtSecret) {
                          setShowJwtSecret(true);
                        }
                      }}
                      disabled={loading || saving}
                      placeholder="Enter JWT secret"
                      autoComplete="off"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      data-bwignore="true"
                      data-form-type="other"
                      role="textbox"
                      inputMode="text"
                      className="mt-1 w-full px-3 py-2 pr-10 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowJwtSecret(!showJwtSecret)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-blue-500 focus:outline-none p-1"
                      tabIndex={-1}
                      aria-label={showJwtSecret ? 'Hide JWT secret' : 'Show JWT secret'}
                    >
                      {showJwtSecret ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                  </div>
                </SettingsField>

                <SettingsFormActions
                  onCancel={handleCancel}
                  onSave={handleSave}
                  saving={saving}
                  disabled={loading || saving}
                />
              </>
            ) : (
              <>
                <SettingsField
                  label="OnlyOffice Document Server URL"
                  description="Base URL of your OnlyOffice Document Server"
                >
                  <SettingsReadonlyValue loading={loading} value={originalUrl} />
                </SettingsField>

                <SettingsField label="JWT Secret" description="Secret key for signing OnlyOffice requests">
                  <SettingsReadonlyValue
                    loading={loading}
                    value={jwtSecretSet ? <span className="font-mono">{'•'.repeat(20)}</span> : ''}
                  />
                </SettingsField>
              </>
            )}
          </div>
        </form>
      )}
    </div>
  );
};
