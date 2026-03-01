import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Link, Pencil, CheckCircle2, XCircle } from 'lucide-react';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../contexts/AuthContext';
import { getShareBaseUrlConfig, updateShareBaseUrlConfig } from '../../../utils/api';
import { getErrorMessage, isAuthError } from '../../../utils/errorUtils';
import { SettingsSection } from '../components/SettingsSection';

interface ShareBaseUrlSectionProps {
  canConfigure: boolean;
}

export const ShareBaseUrlSection: React.FC<ShareBaseUrlSectionProps> = ({ canConfigure }) => {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [url, setUrl] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadSettings = useCallback(async () => {
    if (!user || !canConfigure) {
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      setLoading(true);
      if (abortController.signal.aborted) {
        return;
      }

      const config = await getShareBaseUrlConfig(abortController.signal);
      const urlValue = config.url || '';
      setUrl(urlValue);
      setOriginalUrl(urlValue);
      setIsEditing(false);
      setHasLoadedSettings(true);
      if (urlValue) {
        setIsCollapsed(true);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      if (isAuthError(error)) {
        return;
      }
      showToast('Failed to load share base URL settings', 'error');
    } finally {
      if (!abortController.signal.aborted && abortControllerRef.current === abortController) {
        setLoading(false);
        abortControllerRef.current = null;
      }
    }
  }, [showToast, user, canConfigure]);

  useEffect(() => {
    if (!user) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    }
  }, [user]);

  useEffect(() => {
    if (canConfigure && user) {
      loadSettings();
    }
  }, [canConfigure, user, loadSettings]);

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

  const handleSave = async () => {
    if (!canConfigure) return;

    try {
      setSaving(true);
      const response = await updateShareBaseUrlConfig(url || null);
      const savedUrl = response.url || '';
      setUrl(savedUrl);
      setOriginalUrl(savedUrl);
      setHasLoadedSettings(true);
      setIsEditing(false);
      setIsCollapsed(true);

      showToast('Settings saved', 'success');
    } catch (error) {
      showToast(getErrorMessage(error, 'Failed to save share base URL settings'), 'error');
    } finally {
      setSaving(false);
    }
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
    <SettingsSection
      title="Share Base URL"
      icon={Link}
      description="Configure a custom base URL for public share links (optional)."
    >
      <div className="space-y-4">
        {hasLoadedSettings && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {StatusIcon && (
                <div className={`flex items-center gap-1 ${statusInfo.color}`}>
                  <StatusIcon className="w-4 h-4" />
                  <span className="text-sm font-medium">{statusInfo.text}</span>
                </div>
              )}
            </div>
            <button
              onClick={handleEdit}
              disabled={loading || saving}
              className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              aria-label={isEditing ? 'Cancel editing' : 'Edit share base URL settings'}
            >
              <Pencil className="w-5 h-5" />
            </button>
          </div>
        )}

        {!isCollapsed && (
          <form autoComplete="off" onSubmit={e => e.preventDefault()}>
            <div className="space-y-4">
              {isEditing ? (
                <>
                  <div className="stagger-item hover-lift flex flex-col gap-2 rounded-2xl bg-[#dfe3ea]/95 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                    <label htmlFor="share-base-url" className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Share Base URL
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Base URL for public share links (e.g., https://share.example.com). Leave empty to use the request
                      origin.
                    </p>
                    <input
                      id="share-base-url"
                      type="text"
                      value={url}
                      onChange={e => setUrl(e.target.value)}
                      disabled={loading || saving}
                      placeholder="https://share.example.com"
                      autoComplete="off"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      data-bwignore="true"
                      data-form-type="other"
                      className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#dfe3ea] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>

                  <div className="flex justify-end gap-2">
                    <button
                      onClick={handleCancel}
                      disabled={loading || saving}
                      className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-[#dfe3ea] dark:bg-gray-800 hover:bg-[#d4d9e1] dark:hover:bg-gray-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={loading || saving}
                      className="px-6 py-2 text-sm font-medium rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                    >
                      {saving ? 'Saving...' : 'Save Settings'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="stagger-item hover-lift flex flex-col gap-2 rounded-2xl bg-[#dfe3ea]/95 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                  <label className="text-sm font-medium text-gray-900 dark:text-gray-100">Share Base URL</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Base URL for public share links</p>
                  <div className="mt-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/50 text-gray-900 dark:text-gray-100">
                    {loading ? (
                      <span className="text-gray-500 dark:text-gray-400">Loading...</span>
                    ) : originalUrl ? (
                      originalUrl
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500 italic">
                        Not configured (using request origin)
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </form>
        )}
      </div>
    </SettingsSection>
  );
};
