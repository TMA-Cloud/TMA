import React, { useState, useCallback } from 'react';
import { Link, Pencil, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getShareBaseUrlConfig, updateShareBaseUrlConfig } from '../../../utils/api';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { SettingsField, SettingsReadonlyValue, SettingsFormActions } from '../components/SettingsField';

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

  const isConfigured = !!originalUrl;

  const getStatusInfo = () => {
    if (loading) {
      return {
        text: 'Loading...',
        icon: null,
        color: 'text-gray-500 dark:text-gray-400',
      };
    }
    if (isConfigured) {
      return {
        text: 'Configured',
        icon: CheckCircle2,
        color: 'text-green-600 dark:text-green-400',
      };
    }
    return {
      text: 'Not configured',
      icon: XCircle,
      color: 'text-gray-500 dark:text-gray-400',
    };
  };

  const statusInfo = getStatusInfo();
  const StatusIcon = statusInfo.icon;

  return (
    <div className="relative">
      <div className="flex items-center gap-4 mb-6">
        <div className="p-3 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
          <Link className="w-6 h-6 icon-muted" />
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 tracking-tight">Share Base URL</h3>

            {isCollapsed && hasLoadedSettings && StatusIcon && (
              <div className={`flex items-center gap-1 ${statusInfo.color}`}>
                <StatusIcon className="w-4 h-4" />
                <span className="text-sm font-medium">{statusInfo.text}</span>
              </div>
            )}
          </div>

          <p className="text-sm text-gray-500/80 dark:text-gray-400/80 mt-0.5">
            Configure a custom base URL for public share links
            {isCollapsed && hasLoadedSettings && !StatusIcon && (
              <span className={`ml-2 ${statusInfo.color}`}>{statusInfo.text}</span>
            )}
          </p>
        </div>

        {hasLoadedSettings && (
          <button
            onClick={handleEdit}
            disabled={loading || saving}
            className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            aria-label={isEditing ? 'Cancel editing' : 'Edit share base URL settings'}
          >
            <Pencil className="w-5 h-5" />
          </button>
        )}
      </div>

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
