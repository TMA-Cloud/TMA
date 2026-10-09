import { useCallback, useState } from 'react';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useToast } from '../../../hooks/useToast';
import {
  getStorageConfig,
  testStorageConfig,
  updateStorageConfig,
  type StorageSettingsSummary,
} from '../../../utils/api';
import { ApiError, getErrorMessage } from '../../../utils/errorUtils';
import {
  EMPTY_FORM,
  formFromSummary,
  toStorageInput,
  validateForm,
  type ObjectStorageForm,
} from '../sections/objectStorageForm';

export interface StorageCheckResult {
  ok: boolean;
  message: string;
  /** The check that failed, when the server named one. */
  step?: string;
  checks?: string[];
}

function failureFrom(error: unknown): StorageCheckResult {
  const step = error instanceof ApiError && typeof error.data?.step === 'string' ? error.data.step : undefined;
  return { ok: false, message: getErrorMessage(error, 'The storage settings could not be verified'), step };
}

/** Load, edit, test and save the storage bucket settings. Nothing is saved until the server has verified it. */
export function useObjectStorageSettings({ enabled, onSaved }: { enabled: boolean; onSaved: () => void }) {
  const { showToast } = useToast();
  const [summary, setSummary] = useState<StorageSettingsSummary | null>(null);
  const [form, setForm] = useState<ObjectStorageForm>(EMPTY_FORM);
  const [isEditing, setIsEditing] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<StorageCheckResult | null>(null);

  const { loading } = useAbortableLoader({
    fetcher: getStorageConfig,
    onSuccess: useCallback((data: StorageSettingsSummary) => {
      setSummary(data);
      setForm(formFromSummary(data));
      // An unconfigured instance opens straight into the form: there is nothing else to show.
      setIsEditing(!data.configured);
    }, []),
    errorMessage: 'Failed to load storage settings',
    enabled,
  });

  const hasSavedCredentials = !!summary?.configured;
  const expectedVersion = summary?.version;

  const update = useCallback(<K extends keyof ObjectStorageForm>(key: K, value: ObjectStorageForm[K]) => {
    setForm(previous => ({ ...previous, [key]: value }));
    setResult(null);
  }, []);

  const startEditing = useCallback(() => {
    if (summary) setForm(formFromSummary(summary));
    setResult(null);
    setIsEditing(true);
  }, [summary]);

  const cancelEditing = useCallback(() => {
    if (summary) setForm(formFromSummary(summary));
    setResult(null);
    setIsEditing(!summary?.configured);
  }, [summary]);

  const precheck = useCallback(() => {
    const problem = validateForm(form, hasSavedCredentials);
    if (problem) setResult({ ok: false, message: problem });
    return !problem;
  }, [form, hasSavedCredentials]);

  const test = useCallback(async () => {
    if (!precheck()) return;
    setBusy('test');
    try {
      const { checks } = await testStorageConfig(toStorageInput(form));
      setResult({ ok: true, message: 'Connection works. Save to start using this bucket.', checks });
    } catch (error) {
      setResult(failureFrom(error));
    } finally {
      setBusy(null);
    }
  }, [form, precheck]);

  const save = useCallback(async () => {
    if (!precheck()) return;
    setBusy('save');
    try {
      const saved = await updateStorageConfig(toStorageInput(form, expectedVersion));
      setSummary(saved);
      setForm(formFromSummary(saved));
      setIsEditing(false);
      setResult(null);
      showToast('Storage connected', 'success');
      onSaved();
    } catch (error) {
      setResult(failureFrom(error));
    } finally {
      setBusy(null);
    }
  }, [form, precheck, expectedVersion, showToast, onSaved]);

  return {
    summary,
    form,
    update,
    loading,
    busy,
    result,
    isEditing,
    hasSavedCredentials,
    startEditing,
    cancelEditing,
    test,
    save,
  };
}
