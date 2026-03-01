import React, { useState, useCallback, useEffect, useRef } from 'react';
import { HardDrive, Pencil, CheckCircle2 } from 'lucide-react';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../contexts/AuthContext';
import { getMaxUploadSizeConfig, updateMaxUploadSizeConfig } from '../../../utils/api';
import { getErrorMessage, isAuthError } from '../../../utils/errorUtils';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { formatFileSize } from '../../../utils/fileUtils';

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;
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
  const [maxUploadLoading, setMaxUploadLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditingMaxUpload, setIsEditingMaxUpload] = useState(false);
  const [hasLoadedMaxUpload, setHasLoadedMaxUpload] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadMaxUploadSettings = useCallback(async () => {
    if (!user) return;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    try {
      setMaxUploadLoading(true);
      if (abortController.signal.aborted) return;
      const config = await getMaxUploadSizeConfig(abortController.signal);
      setMaxBytes(config.maxBytes);
      setSizeInput('');
      setSizeUnit('GB');
      setIsEditingMaxUpload(false);
      setHasLoadedMaxUpload(true);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (isAuthError(error)) return;
      showToast('Failed to load max upload size settings', 'error');
    } finally {
      if (!abortController.signal.aborted && abortControllerRef.current === abortController) {
        setMaxUploadLoading(false);
        abortControllerRef.current = null;
      }
    }
  }, [showToast, user]);

  useEffect(() => {
    if (!user && abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, [user]);

  useEffect(() => {
    if (user && canConfigure) loadMaxUploadSettings();
  }, [user, canConfigure, loadMaxUploadSettings]);

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

  const handleSaveMaxUpload = async () => {
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
    try {
      setSaving(true);
      const response = await updateMaxUploadSizeConfig(newBytes);
      setMaxBytes(response.maxBytes);
      setIsEditingMaxUpload(false);
      setHasLoadedMaxUpload(true);
      showToast('Settings saved', 'success');
    } catch (error) {
      showToast(getErrorMessage(error, 'Failed to save max upload size settings'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const totalLabel = usage && usage.total !== null ? formatFileSize(usage.total) : 'Unlimited';
  const availableLabel = usage && usage.free !== null ? formatFileSize(usage.free) : 'Unlimited';

  return (
    <SettingsSection title="Storage" icon={HardDrive} description="Track how your allocated drive space is being used.">
      <div className="space-y-4">
        <SettingsItem
          label="Used Space"
          value={loading || !usage ? 'Loading...' : `${formatFileSize(usage.used)} of ${totalLabel}`}
        />
        <SettingsItem label="Available Space" value={loading || !usage ? 'Loading...' : availableLabel} />

        {canConfigure && (
          <>
            {hasLoadedMaxUpload && !isEditingMaxUpload && (
              <div className="stagger-item hover-lift flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl bg-[#dfe3ea]/95 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Max upload size</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Maximum size for a single uploaded file (applies to all users).
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
                  <div className="stagger-item hover-lift flex flex-col gap-2 rounded-2xl bg-[#dfe3ea]/95 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200">
                    <label
                      htmlFor="max-upload-size-value"
                      className="text-sm font-medium text-gray-900 dark:text-gray-100"
                    >
                      Max upload size
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Allowed range: {MIN_LABEL} to {MAX_LABEL} per file.
                    </p>
                    <div className="mt-1 flex gap-2">
                      <input
                        id="max-upload-size-value"
                        type="number"
                        min={sizeUnit === 'GB' ? MIN_GB : MIN_MB}
                        max={sizeUnit === 'GB' ? MAX_GB : MAX_MB}
                        step={sizeUnit === 'GB' ? 0.1 : 1}
                        value={sizeInput}
                        onChange={e => setSizeInput(e.target.value)}
                        disabled={maxUploadLoading || saving}
                        autoComplete="off"
                        data-form-type="other"
                        className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#dfe3ea] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                      />
                      <select
                        aria-label="Unit"
                        value={sizeUnit}
                        onChange={e => handleUnitChange(e.target.value as SizeUnit)}
                        disabled={maxUploadLoading || saving}
                        className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[#dfe3ea] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <option value="MB">MB</option>
                        <option value="GB">GB</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={handleCancelMaxUpload}
                      disabled={maxUploadLoading || saving}
                      className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-[#dfe3ea] dark:bg-gray-800 hover:bg-[#d4d9e1] dark:hover:bg-gray-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveMaxUpload}
                      disabled={maxUploadLoading || saving}
                      className="px-6 py-2 text-sm font-medium rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
};
