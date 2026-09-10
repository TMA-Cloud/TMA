import React, { useCallback, useState } from 'react';
import { Network } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { getKnownProxiesConfig, updateKnownProxiesConfig } from '../../../utils/api';
import { ConfigSectionHeader } from '../components/ConfigSectionHeader';
import { SettingsField, SettingsFormActions, SettingsReadonlyValue } from '../components/SettingsField';

interface KnownProxiesSectionProps {
  canConfigure: boolean;
}

const parseEntries = (value: string) =>
  value
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean);

export const KnownProxiesSection: React.FC<KnownProxiesSectionProps> = ({ canConfigure }) => {
  const { user } = useAuth();
  const [value, setValue] = useState('');
  const [originalValue, setOriginalValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  const { loading } = useAbortableLoader({
    fetcher: getKnownProxiesConfig,
    onSuccess: useCallback((config: { knownProxies: string[] }) => {
      const nextValue = config.knownProxies.join(', ');
      setValue(nextValue);
      setOriginalValue(nextValue);
      setIsEditing(false);
      setHasLoadedSettings(true);
      setIsCollapsed(true);
    }, []),
    errorMessage: 'Failed to load known proxy settings',
    enabled: !!user && canConfigure,
  });

  const handleEdit = () => {
    if (isCollapsed) {
      setIsCollapsed(false);
      setIsEditing(true);
    } else if (isEditing) {
      setValue(originalValue);
      setIsEditing(false);
      setIsCollapsed(true);
    } else {
      setIsEditing(true);
    }
  };

  const saveAction = useCallback(async (nextValue: string) => {
    const response = await updateKnownProxiesConfig(parseEntries(nextValue));
    const savedValue = response.knownProxies.join(', ');
    setValue(savedValue);
    setOriginalValue(savedValue);
    setRestartRequired(response.restartRequired);
    setIsEditing(false);
    setIsCollapsed(true);
  }, []);
  const { run: runSave, busy: saving } = useAsyncAction(saveAction, {
    errorMessage: 'Failed to save known proxy settings',
    successMessage: 'Known proxies saved — restart the server to apply them',
  });

  if (!canConfigure) return null;

  return (
    <div className="relative">
      <ConfigSectionHeader
        icon={Network}
        title="Known Proxies"
        description="Trust forwarded client IPs only from these reverse proxies"
        isConfigured={!!originalValue}
        loading={loading}
        saving={saving}
        isCollapsed={isCollapsed}
        isEditing={isEditing}
        hasLoadedSettings={hasLoadedSettings}
        editLabel="known proxy settings"
        onEdit={handleEdit}
      />

      {restartRequired && (
        <p className="mb-4 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
          Restart the server to apply this change.
        </p>
      )}

      {!isCollapsed && (
        <form autoComplete="off" onSubmit={event => event.preventDefault()}>
          <div className="space-y-4">
            {isEditing ? (
              <>
                <SettingsField
                  htmlFor="known-proxies"
                  label="Known Proxies"
                  description="Comma-separated IP addresses, CIDR ranges, or hostnames. Only listed proxies may supply X-Forwarded-For."
                >
                  <textarea
                    id="known-proxies"
                    rows={3}
                    value={value}
                    onChange={event => setValue(event.target.value)}
                    disabled={loading || saving}
                    placeholder="10.1.2.100, 172.18.0.0/16, proxy.example.com"
                    className="mt-1 w-full resize-y px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </SettingsField>
                <SettingsFormActions
                  onCancel={() => {
                    setValue(originalValue);
                    setIsEditing(false);
                    setIsCollapsed(true);
                  }}
                  onSave={() => runSave(value)}
                  saving={saving}
                  disabled={loading || saving}
                />
              </>
            ) : (
              <SettingsField label="Known Proxies" description="A server restart is required after changing this list.">
                <SettingsReadonlyValue
                  value={originalValue}
                  emptyText="None (forwarded client IP headers are ignored)"
                />
              </SettingsField>
            )}
          </div>
        </form>
      )}
    </div>
  );
};
