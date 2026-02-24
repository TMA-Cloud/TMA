import React, { useState, useCallback, useEffect, useRef } from 'react';
import { FileText, Pencil, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { useToast } from '../../../hooks/useToast';
import { useApp } from '../../../contexts/AppContext';
import { useAuth } from '../../../contexts/AuthContext';
import { getOnlyOfficeConfig, updateOnlyOfficeConfig } from '../../../utils/api';
import { getErrorMessage, isAuthError } from '../../../utils/errorUtils';

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false);
  const [showJwtSecret, setShowJwtSecret] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadSettings = useCallback(async () => {
    // Don't load settings if user is not authenticated
    if (!user || !canConfigure) {
      return;
    }

    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      setLoading(true);
      // Check if request was aborted before making the call
      if (abortController.signal.aborted) {
        return;
      }

      const config = await getOnlyOfficeConfig(abortController.signal);
      const urlValue = config.url || '';
      // Never prefill JWT secret - always start empty
      setJwtSecret('');
      setUrl(urlValue);
      setJwtSecretSet(config.jwtSecretSet);
      setOriginalUrl(urlValue);
      setIsEditing(false);
      setHasLoadedSettings(true);
      // Collapse if settings exist
      if (config.jwtSecretSet || urlValue) {
        setIsCollapsed(true);
      }
    } catch (error) {
      // Ignore abort errors (expected when cancelling requests)
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      // Don't show error toast for authentication errors - expected after logout
      if (isAuthError(error)) {
        return;
      }
      // Error handled by toast notification
      showToast('Failed to load OnlyOffice settings', 'error');
    } finally {
      // Only update loading state if this request wasn't aborted
      if (!abortController.signal.aborted && abortControllerRef.current === abortController) {
        setLoading(false);
        abortControllerRef.current = null;
      }
    }
  }, [showToast, user, canConfigure]);

  // Cancel any in-flight requests when user logs out
  useEffect(() => {
    if (!user) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    }
  }, [user]);

  useEffect(() => {
    // Only load settings if user is authenticated and can configure
    if (canConfigure && user) {
      loadSettings();
    }
  }, [canConfigure, user, loadSettings]);

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

  const handleSave = async () => {
    if (!canConfigure) return;

    try {
      setSaving(true);
      // Backend handles all validation (trimming, URL format, both-or-none rule)
      // Send raw values - backend will validate and return appropriate error messages
      const response = await updateOnlyOfficeConfig(jwtSecret || null, url || null);
      const savedUrl = response.url || '';
      // Never store JWT secret - always clear it after save
      setJwtSecret('');
      setUrl(savedUrl);
      setJwtSecretSet(response.jwtSecretSet);
      setOriginalUrl(savedUrl);
      setHasLoadedSettings(true);
      setIsEditing(false);
      setIsCollapsed(true);

      // Refresh OnlyOffice config cache in app context (after backend cache is invalidated)
      try {
        await refreshOnlyOfficeConfig();
      } catch {
        // Error handled silently - cache refresh is non-critical
      }

      // Show appropriate message based on what was saved
      if (response.jwtSecretSet && savedUrl) {
        showToast('Settings saved', 'success');
      } else {
        showToast('Settings cleared', 'success');
      }
    } catch (error) {
      // Error handled by toast notification
      showToast(getErrorMessage(error, 'Failed to save OnlyOffice settings'), 'error');
      // Don't collapse on error so user can see and fix
    } finally {
      setSaving(false);
    }
  };

  if (!canConfigure) {
    return null;
  }

  // Consider configured if URL exists and JWT secret is set
  const isConfigured = originalUrl && jwtSecretSet;

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
    <div
      className="relative overflow-hidden card-premium hover-lift spacing-card"
      style={{
        animation: 'slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="p-3 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
          <FileText className="w-5 h-5 icon-muted" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
              OnlyOffice Integration
            </h3>
            {isCollapsed && hasLoadedSettings && StatusIcon && (
              <div className={`flex items-center gap-1 ${statusInfo.color}`}>
                <StatusIcon className="w-4 h-4" />
                <span className="text-sm font-medium">{statusInfo.text}</span>
              </div>
            )}
          </div>
          <p className="text-sm text-gray-500/80 dark:text-gray-400/80">
            Configure OnlyOffice Document Server for document editing and viewing.
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
            aria-label={isEditing ? 'Cancel editing' : 'Edit OnlyOffice settings'}
          >
            <Pencil className="w-5 h-5" />
          </button>
        )}
      </div>

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
                  <div className="stagger-item rounded-2xl bg-blue-50 dark:bg-blue-900/20 px-4 py-3 border border-blue-200 dark:border-blue-800">
                    <p className="text-sm text-blue-700 dark:text-blue-300">
                      To change settings, re-enter both URL and JWT secret. To clear, clear both fields.
                    </p>
                  </div>
                )}
                <div className="stagger-item hover-lift flex flex-col gap-2 rounded-2xl bg-gray-50/70 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                  <label htmlFor="onlyoffice-url" className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    OnlyOffice Document Server URL
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Base URL of your OnlyOffice Document Server (e.g., http://localhost or
                    https://documentserver.example.com)
                  </p>
                  <input
                    id="onlyoffice-url"
                    type="text"
                    name="x-server-url-config"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    disabled={loading || saving}
                    placeholder="http://localhost"
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    data-bwignore="true"
                    data-form-type="other"
                    className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </div>

                <div className="stagger-item hover-lift flex flex-col gap-2 rounded-2xl bg-gray-50/70 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                  <label
                    htmlFor="onlyoffice-jwt-secret"
                    className="text-sm font-medium text-gray-900 dark:text-gray-100"
                  >
                    JWT Secret
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Secret key for signing OnlyOffice requests. Must match the secret configured in your OnlyOffice
                    Document Server.
                  </p>
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
                      className="mt-1 w-full px-3 py-2 pr-10 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed font-mono"
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
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={handleCancel}
                    disabled={loading || saving}
                    className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
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
              <>
                <div className="stagger-item hover-lift flex flex-col gap-2 rounded-2xl bg-gray-50/70 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                  <label className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    OnlyOffice Document Server URL
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Base URL of your OnlyOffice Document Server
                  </p>
                  <div className="mt-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/50 text-gray-900 dark:text-gray-100">
                    {loading ? (
                      <span className="text-gray-500 dark:text-gray-400">Loading...</span>
                    ) : originalUrl ? (
                      originalUrl
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500 italic">Not configured</span>
                    )}
                  </div>
                </div>

                <div className="stagger-item hover-lift flex flex-col gap-2 rounded-2xl bg-gray-50/70 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                  <label className="text-sm font-medium text-gray-900 dark:text-gray-100">JWT Secret</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Secret key for signing OnlyOffice requests</p>
                  <div className="mt-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/50 text-gray-900 dark:text-gray-100">
                    {loading ? (
                      <span className="text-gray-500 dark:text-gray-400">Loading...</span>
                    ) : jwtSecretSet ? (
                      <span className="font-mono">{'•'.repeat(20)}</span>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500 italic">Not configured</span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </form>
      )}
    </div>
  );
};
