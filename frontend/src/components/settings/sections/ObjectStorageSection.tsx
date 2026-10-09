import React, { useState } from 'react';
import { Database, Eye, EyeOff, CircleCheck, CircleAlert } from 'lucide-react';
import type { StorageProvider } from '../../../utils/api';
import { ConfigSectionHeader } from '../components/ConfigSectionHeader';
import { SettingsField, SettingsReadonlyValue } from '../components/SettingsField';
import { SettingsNote } from '../components/SettingsNote';
import { useObjectStorageSettings, type StorageCheckResult } from '../hooks/useObjectStorageSettings';
import { PROVIDER_LABELS, PROVIDER_OPTIONS, checkLabel, type R2Jurisdiction } from './objectStorageForm';

const INPUT_CLASS =
  'mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[var(--surface-raised)] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed';

// Keeps password managers from offering to save or fill bucket credentials.
const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  spellCheck: false,
} as const;

const CheckResult: React.FC<{ result: StorageCheckResult }> = ({ result }) => (
  <div
    role={result.ok ? 'status' : 'alert'}
    className={`flex items-start gap-2.5 rounded-xl px-4 py-3 border ${
      result.ok
        ? 'border-green-300/60 dark:border-green-700/50 bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-200'
        : 'border-red-300/60 dark:border-red-700/50 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200'
    }`}
  >
    {result.ok ? (
      <CircleCheck className="w-4 h-4 shrink-0 mt-0.5" />
    ) : (
      <CircleAlert className="w-4 h-4 shrink-0 mt-0.5" />
    )}
    <div className="type-caption space-y-1">
      <p>
        {result.step && <span className="font-semibold">{checkLabel(result.step)} failed: </span>}
        {result.message}
      </p>
      {result.checks && result.checks.length > 0 && (
        <p className="opacity-80">Passed: {result.checks.map(checkLabel).join(' · ')}</p>
      )}
    </div>
  </div>
);

export const ObjectStorageSection: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const storage = useObjectStorageSettings({ enabled: true, onSaved });
  const { form, update, summary, isEditing, busy, loading, hasSavedCredentials } = storage;
  const [showSecret, setShowSecret] = useState(false);
  const disabled = loading || busy !== null;
  const configured = !!summary?.configured;

  return (
    <div className="rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3 transition-all duration-200 hover:border-blue-500/30 dark:hover:border-blue-500/30">
      <ConfigSectionHeader
        icon={Database}
        title="Storage bucket"
        description="The S3-compatible bucket that holds every file, encrypted"
        isConfigured={configured}
        loading={loading}
        saving={busy !== null}
        isCollapsed={!isEditing}
        isEditing={isEditing}
        hasLoadedSettings={!!summary}
        editLabel="storage bucket settings"
        onEdit={isEditing ? storage.cancelEditing : storage.startEditing}
        status={
          configured
            ? { text: `${PROVIDER_LABELS[summary.provider!]} · ${summary.bucket}`, tone: 'success' }
            : { text: 'Not set up', tone: 'warning' }
        }
      />

      {!isEditing && configured && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SettingsField label="Endpoint">
            <SettingsReadonlyValue value={<span className="font-mono break-all">{summary.endpoint}</span>} />
          </SettingsField>
          <SettingsField label="Access key">
            <SettingsReadonlyValue value={<span className="font-mono">{summary.accessKeyIdMasked}</span>} />
          </SettingsField>
        </div>
      )}

      {isEditing && (
        <form className="mt-4 space-y-4" autoComplete="off" onSubmit={event => event.preventDefault()}>
          {!configured && (
            <SettingsNote tone="warning">
              No bucket is connected yet, so nobody can upload or open files. Create a private bucket and an access key
              limited to it, then enter them here.
            </SettingsNote>
          )}

          <SettingsField htmlFor="storage-provider" label="Provider">
            <select
              id="storage-provider"
              value={form.provider}
              onChange={event => update('provider', event.target.value as StorageProvider)}
              disabled={disabled}
              className={INPUT_CLASS}
            >
              {PROVIDER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingsField>

          {form.provider === 'r2' && (
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <SettingsField
                htmlFor="storage-account-id"
                label="Account ID"
                description="Shown on the R2 overview page in the Cloudflare dashboard"
              >
                <input
                  id="storage-account-id"
                  value={form.accountId}
                  onChange={event => update('accountId', event.target.value)}
                  disabled={disabled}
                  placeholder="0123456789abcdef0123456789abcdef"
                  className={`${INPUT_CLASS} font-mono`}
                  {...NO_AUTOFILL}
                />
              </SettingsField>
              <SettingsField htmlFor="storage-jurisdiction" label="Jurisdiction">
                <select
                  id="storage-jurisdiction"
                  value={form.jurisdiction}
                  onChange={event => update('jurisdiction', event.target.value as R2Jurisdiction)}
                  disabled={disabled}
                  className={INPUT_CLASS}
                >
                  <option value="default">Default</option>
                  <option value="eu">European Union</option>
                  <option value="fedramp">FedRAMP</option>
                </select>
              </SettingsField>
            </div>
          )}

          {form.provider !== 'r2' && (
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <SettingsField
                htmlFor="storage-endpoint"
                label={form.provider === 'aws' ? 'Endpoint (optional)' : 'Endpoint URL'}
                description={
                  form.provider === 'aws'
                    ? 'Leave blank to use the standard endpoint for the region'
                    : 'https:// for public hosts; http:// is accepted only on a private network'
                }
              >
                <input
                  id="storage-endpoint"
                  value={form.endpoint}
                  onChange={event => update('endpoint', event.target.value)}
                  disabled={disabled}
                  placeholder={
                    form.provider === 'aws' ? 'https://s3.eu-west-1.amazonaws.com' : 'https://s3.example.com'
                  }
                  className={`${INPUT_CLASS} font-mono`}
                  {...NO_AUTOFILL}
                />
              </SettingsField>
              <SettingsField htmlFor="storage-region" label={form.provider === 'aws' ? 'Region' : 'Region (optional)'}>
                <input
                  id="storage-region"
                  value={form.region}
                  onChange={event => update('region', event.target.value)}
                  disabled={disabled}
                  placeholder={form.provider === 'aws' ? 'eu-west-1' : 'us-east-1'}
                  className={`${INPUT_CLASS} font-mono`}
                  {...NO_AUTOFILL}
                />
              </SettingsField>
            </div>
          )}

          <SettingsField htmlFor="storage-bucket" label="Bucket name">
            <input
              id="storage-bucket"
              value={form.bucket}
              onChange={event => update('bucket', event.target.value)}
              disabled={disabled}
              placeholder="tma-cloud-files"
              className={`${INPUT_CLASS} font-mono`}
              {...NO_AUTOFILL}
            />
          </SettingsField>

          {form.provider === 's3' && (
            <label className="flex items-start gap-3 rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3">
              <input
                type="checkbox"
                checked={form.forcePathStyle}
                onChange={event => update('forcePathStyle', event.target.checked)}
                disabled={disabled}
                className="mt-1"
              />
              <span>
                <span className="type-callout font-medium text-gray-900 dark:text-gray-100">Path-style addressing</span>
                <span className="block type-caption text-gray-500 dark:text-gray-400">
                  Needed by RustFS and MinIO unless they serve buckets on their own subdomains
                </span>
              </span>
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsField htmlFor="storage-access-key" label="Access key ID">
              <input
                id="storage-access-key"
                value={form.accessKeyId}
                onChange={event => update('accessKeyId', event.target.value)}
                disabled={disabled}
                placeholder={hasSavedCredentials ? `Keep ${summary?.accessKeyIdMasked ?? 'saved key'}` : ''}
                className={`${INPUT_CLASS} font-mono`}
                {...NO_AUTOFILL}
              />
            </SettingsField>
            <SettingsField htmlFor="storage-secret" label="Secret access key">
              <div className="relative">
                <input
                  id="storage-secret"
                  type={showSecret ? 'text' : 'password'}
                  value={form.secretAccessKey}
                  onChange={event => update('secretAccessKey', event.target.value)}
                  disabled={disabled}
                  placeholder={hasSavedCredentials ? 'Keep the saved secret' : ''}
                  className={`${INPUT_CLASS} pr-10 font-mono`}
                  {...NO_AUTOFILL}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(value => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 mt-0.5 text-gray-400 hover:text-blue-500 focus:outline-none p-1"
                  aria-label={showSecret ? 'Hide secret access key' : 'Show secret access key'}
                >
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </SettingsField>
          </div>

          {configured && (
            <SettingsNote>
              Leave both keys blank to keep the saved ones. A different endpoint or bucket is only accepted if it
              already holds the files stored so far.
            </SettingsNote>
          )}

          {storage.result && <CheckResult result={storage.result} />}

          <div className="flex flex-wrap justify-end gap-2">
            {configured && (
              <button
                type="button"
                onClick={storage.cancelEditing}
                disabled={disabled}
                className="px-4 py-2 type-footnote font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-[var(--surface-raised)] dark:bg-gray-800 hover:bg-[var(--surface)] dark:hover:bg-gray-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={() => void storage.test()}
              disabled={disabled}
              className="px-4 py-2 type-footnote font-medium rounded-lg border border-blue-500/60 text-blue-600 dark:text-blue-300 bg-[var(--surface-raised)] dark:bg-gray-800 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button
              type="button"
              onClick={() => void storage.save()}
              disabled={disabled}
              className="px-6 py-2 type-footnote font-medium rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'save' ? 'Verifying and saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
