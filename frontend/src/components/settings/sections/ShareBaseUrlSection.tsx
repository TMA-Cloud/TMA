import React, { useState, useCallback } from 'react';
import { Link } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getShareBaseUrlConfig, updateShareBaseUrlConfig } from '../../../utils/api';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { SettingsField, SettingsReadonlyValue, SettingsFormActions } from '../components/SettingsField';
import { ConfigSectionHeader } from '../components/ConfigSectionHeader';

interface ShareBaseUrlSectionProps {
  canConfigure: boolean;
}

export const ShareBaseUrlSection: React.FC<ShareBaseUrlSectionProps> = ({ canConfigure }) => {
  const { user } = useAuth();
  const [url, setUrl] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false);

  const { loading } = useAbortableLoader({
    fetcher: getShareBaseUrlConfig,
    onSuccess: useCallback((config: { url: string | null }) => {
      const urlValue = config.url || '';
      setUrl(urlValue);
      setOriginalUrl(urlValue);
      setIsEditing(false);
      setHasLoadedSettings(true);
      setIsCollapsed(true);
    }, []),
    errorMessage: 'Failed to load share base URL settings',
    enabled: !!user && canConfigure,
  });

  const handleEdit = () => {
    if (isCollapsed) {
      setIsCollapsed(false);
      setIsEditing(true);
    } else if (isEditing) {
      setIsCollapsed(true);
      setIsEditing(false);
      setUrl(originalUrl);
    } else {
      setIsEditing(true);
    }
  };

  const handleCancel = () => {
    setUrl(originalUrl);
    setIsEditing(false);
    setIsCollapsed(true);
  };

  const saveAction = useCallback(async (next: string) => {
    const response = await updateShareBaseUrlConfig(next || null);
    const savedUrl = response.url || '';
    setUrl(savedUrl);
    setOriginalUrl(savedUrl);
    setHasLoadedSettings(true);
    setIsEditing(false);
    setIsCollapsed(true);
  }, []);
  const { run: runSave, busy: saving } = useAsyncAction(saveAction, {
    errorMessage: 'Failed to save share base URL settings',
    successMessage: 'Settings saved',
  });

  const handleSave = () => {
    if (!canConfigure) return;
    runSave(url);
  };

  if (!canConfigure) {
    return null;
  }

  return (
    <div className="relative">
      <ConfigSectionHeader
        icon={Link}
        title="Share Base URL"
        description="Configure a custom base URL for public share links"
        isConfigured={!!originalUrl}
        loading={loading}
        saving={saving}
        isCollapsed={isCollapsed}
        isEditing={isEditing}
        hasLoadedSettings={hasLoadedSettings}
        editLabel="share base URL settings"
        onEdit={handleEdit}
      />

      {!isCollapsed && (
        <form autoComplete="off" onSubmit={e => e.preventDefault()}>
          <div className="space-y-4">
            {isEditing ? (
              <>
                <SettingsField
                  htmlFor="share-base-url"
                  label="Share Base URL"
                  description="Base URL for public share links"
                >
                  <input
                    id="share-base-url"
                    type="text"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    disabled={loading || saving}
                    placeholder="http://share.example.com"
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    data-bwignore="true"
                    data-form-type="other"
                    className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </SettingsField>

                <SettingsFormActions
                  onCancel={handleCancel}
                  onSave={handleSave}
                  saving={saving}
                  disabled={loading || saving}
                />
              </>
            ) : (
              <SettingsField label="Share Base URL" description="Base URL for public share links">
                <SettingsReadonlyValue
                  loading={loading}
                  value={originalUrl}
                  emptyText="Not configured (using request origin)"
                />
              </SettingsField>
            )}
          </div>
        </form>
      )}
    </div>
  );
};
