import React, { useState, useCallback } from 'react';
import { HardDrive, Pencil, CheckCircle2 } from 'lucide-react';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../contexts/AuthContext';
import { getMaxUploadSizeConfig, updateMaxUploadSizeConfig } from '../../../utils/api';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { SettingsField, SettingsFormActions } from '../components/SettingsField';
import { NumberInput } from '../../ui/NumberInput';
import { formatFileSize } from '../../../utils/fileUtils';
import { BYTES_PER_MB, BYTES_PER_GB } from '../../../utils/storageUtils';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';

const MIN_MB = 1;
const MAX_MB = 100 * 1024; // 100 GB in MB
const MIN_GB = 1 / 1024;
const MAX_GB = 100;
const MIN_LABEL = '1 MB';
const MAX_LABEL = '100 GB';

type SizeUnit = 'MB' | 'GB';

function bytesToMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 1000) / 1000;
}

function bytesToGb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GB) * 1000) / 1000;
}

function mbToBytes(mb: number): number {
  return Math.round(mb * BYTES_PER_MB);
}

function gbToBytes(gb: number): number {
  return Math.round(gb * BYTES_PER_GB);
}

function formatMaxUploadSize(bytes: number): string {
  if (bytes >= BYTES_PER_GB) {
    const gb = bytesToGb(bytes);
    return `${gb} GB`;
  }
  const mb = Math.round(bytes / (1024 * 1024));
  return `${mb} MB`;
}

interface StorageSectionProps {
  usage?: {
    used: number;
    total: number | null;
    free: number | null;
  };
  loading?: boolean;
  canConfigure?: boolean;
}

export const StorageSection: React.FC<StorageSectionProps> = ({ usage, loading, canConfigure }) => {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [maxBytes, setMaxBytes] = useState<number>(10 * BYTES_PER_GB);
  const [sizeInput, setSizeInput] = useState<string>('10');
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('GB');
  const [isEditingMaxUpload, setIsEditingMaxUpload] = useState(false);
  const [hasLoadedMaxUpload, setHasLoadedMaxUpload] = useState(false);

  const { loading: maxUploadLoading } = useAbortableLoader({
    fetcher: getMaxUploadSizeConfig,
    onSuccess: useCallback((config: { maxBytes: number }) => {
      setMaxBytes(config.maxBytes);
      setSizeInput('');
      setSizeUnit('GB');
      setIsEditingMaxUpload(false);
      setHasLoadedMaxUpload(true);
    }, []),
    errorMessage: 'Failed to load max upload size settings',
    enabled: !!user && !!canConfigure,
  });

  const handleEditMaxUpload = () => {
    setIsEditingMaxUpload(true);
    const useGb = maxBytes >= BYTES_PER_GB;
    setSizeUnit(useGb ? 'GB' : 'MB');
    setSizeInput(useGb ? bytesToGb(maxBytes).toString() : bytesToMb(maxBytes).toString());
  };

  const handleCancelMaxUpload = () => {
    setIsEditingMaxUpload(false);
  };

  const handleUnitChange = (newUnit: SizeUnit) => {
    const num = parseFloat(sizeInput);
    if (Number.isNaN(num)) {
      setSizeUnit(newUnit);
      return;
    }
    const bytes = sizeUnit === 'GB' ? gbToBytes(num) : mbToBytes(num);
    setSizeUnit(newUnit);
    setSizeInput(newUnit === 'GB' ? bytesToGb(bytes).toString() : bytesToMb(bytes).toString());
  };

  const saveMaxUploadAction = useCallback(async (newBytes: number) => {
    const response = await updateMaxUploadSizeConfig(newBytes);
    setMaxBytes(response.maxBytes);
    setIsEditingMaxUpload(false);
    setHasLoadedMaxUpload(true);
  }, []);
  const { run: runSaveMaxUpload, busy: saving } = useAsyncAction(saveMaxUploadAction, {
    errorMessage: 'Failed to save max upload size settings',
    successMessage: 'Settings saved',
  });

  const handleSaveMaxUpload = () => {
    if (!canConfigure) return;
    const num = parseFloat(sizeInput);
    if (Number.isNaN(num) || num <= 0) {
      showToast(`Enter a value between ${MIN_LABEL} and ${MAX_LABEL}`, 'error');
      return;
    }
    let newBytes: number;
    if (sizeUnit === 'GB') {
      if (num < MIN_GB || num > MAX_GB) {
        showToast(`Enter a value between ${MIN_LABEL} and ${MAX_LABEL}`, 'error');
        return;
      }
      newBytes = gbToBytes(num);
    } else {
      if (num < MIN_MB || num > MAX_MB) {
        showToast(`Enter a value between ${MIN_LABEL} and ${MAX_LABEL}`, 'error');
        return;
      }
      newBytes = mbToBytes(num);
    }
    runSaveMaxUpload(newBytes);
  };

  const totalLabel = usage && usage.total !== null ? formatFileSize(usage.total) : 'Unlimited';
  const availableLabel = usage && usage.free !== null ? formatFileSize(usage.free) : 'Unlimited';

  return (
    <SettingsSection title="Storage" icon={HardDrive} description="Usage and upload limits">
      <div className="space-y-4">
        <SettingsItem
          label="Used Space"
          value={loading || !usage ? 'Loading...' : `${formatFileSize(usage.used)} of ${totalLabel}`}
        />
        <SettingsItem label="Available Space" value={loading || !usage ? 'Loading...' : availableLabel} />

        {canConfigure && (
          <>
            {hasLoadedMaxUpload && !isEditingMaxUpload && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-5 py-4 hover:border-blue-500/30 transition-all duration-200">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Max upload size</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Maximum size for a single uploaded file (applies to all users)
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-base font-semibold">
                      {maxUploadLoading ? 'Loading...' : formatMaxUploadSize(maxBytes)}
                    </span>
                  </div>
                  <button
                    onClick={handleEditMaxUpload}
                    disabled={maxUploadLoading || saving}
                    className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                    aria-label="Edit max upload size"
                  >
                    <Pencil className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}

            {isEditingMaxUpload && (
              <form autoComplete="off" onSubmit={e => e.preventDefault()}>
                <div className="space-y-4">
                  <SettingsField
                    htmlFor="max-upload-size-value"
                    label="Max upload size"
                    description={`Allowed range: ${MIN_LABEL} to ${MAX_LABEL} per file`}
                  >
                    <div className="mt-1 flex gap-2">
                      <NumberInput
                        id="max-upload-size-value"
                        value={sizeInput}
                        onValueChange={setSizeInput}
                        disabled={maxUploadLoading || saving}
                        data-form-type="other"
                        className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                      />
                      <select
                        aria-label="Unit"
                        value={sizeUnit}
                        onChange={e => handleUnitChange(e.target.value as SizeUnit)}
                        disabled={maxUploadLoading || saving}
                        className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <option value="MB">MB</option>
                        <option value="GB">GB</option>
                      </select>
                    </div>
                  </SettingsField>
                  <SettingsFormActions
                    onCancel={handleCancelMaxUpload}
                    onSave={handleSaveMaxUpload}
                    saving={saving}
                    disabled={maxUploadLoading || saving}
                    saveLabel="Save"
                  />
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
};
