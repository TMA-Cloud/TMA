/** Pure form logic for the storage bucket settings: provider presets and conversion to the API shape. */
import type { StorageProvider, StorageSettingsInput, StorageSettingsSummary } from '../../../utils/api';

export type R2Jurisdiction = 'default' | 'eu' | 'fedramp';

export interface ObjectStorageForm {
  provider: StorageProvider;
  /** R2 only: the endpoint is built from the account ID and jurisdiction. */
  accountId: string;
  jurisdiction: R2Jurisdiction;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export const PROVIDER_OPTIONS: { value: StorageProvider; label: string }[] = [
  { value: 'r2', label: 'Cloudflare R2' },
  { value: 'aws', label: 'Amazon S3' },
  { value: 's3', label: 'Other S3-compatible (RustFS, MinIO, Ceph…)' },
];

export const PROVIDER_LABELS: Record<StorageProvider, string> = {
  r2: 'Cloudflare R2',
  aws: 'Amazon S3',
  s3: 'S3-compatible',
};

export const EMPTY_FORM: ObjectStorageForm = {
  provider: 'r2',
  accountId: '',
  jurisdiction: 'default',
  endpoint: '',
  region: '',
  bucket: '',
  forcePathStyle: true,
  accessKeyId: '',
  secretAccessKey: '',
};

const R2_ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const R2_ENDPOINT = /^https:\/\/([0-9a-f]{32})(?:\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$/i;

/** @internal Exported for tests. */
export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction): string {
  const id = accountId.trim().toLowerCase();
  return `https://${id}${jurisdiction === 'default' ? '' : `.${jurisdiction}`}.r2.cloudflarestorage.com`;
}

/** @internal Exported for tests. */
export function parseR2Endpoint(endpoint: string): { accountId: string; jurisdiction: R2Jurisdiction } | null {
  const match = R2_ENDPOINT.exec(endpoint);
  const [, accountId, jurisdiction] = match ?? [];
  if (!accountId) return null;
  return {
    accountId: accountId.toLowerCase(),
    jurisdiction: (jurisdiction?.toLowerCase() as R2Jurisdiction) ?? 'default',
  };
}

/** Saved settings as an editable form. Credentials start blank, meaning "keep the saved pair". */
export function formFromSummary(summary: StorageSettingsSummary): ObjectStorageForm {
  if (!summary.configured || !summary.provider) return EMPTY_FORM;
  const endpoint = summary.endpoint ?? '';
  const r2 = summary.provider === 'r2' ? parseR2Endpoint(endpoint) : null;
  return {
    ...EMPTY_FORM,
    provider: summary.provider,
    accountId: r2?.accountId ?? '',
    jurisdiction: r2?.jurisdiction ?? 'default',
    endpoint,
    region: summary.region === 'auto' ? '' : (summary.region ?? ''),
    bucket: summary.bucket ?? '',
    forcePathStyle: summary.forcePathStyle ?? true,
  };
}

export function toStorageInput(form: ObjectStorageForm, expectedVersion?: number): StorageSettingsInput {
  const endpoint =
    form.provider === 'r2' && form.accountId.trim()
      ? r2Endpoint(form.accountId, form.jurisdiction)
      : form.endpoint.trim();
  return {
    provider: form.provider,
    endpoint,
    region: form.region.trim(),
    bucket: form.bucket.trim(),
    forcePathStyle: form.forcePathStyle,
    accessKeyId: form.accessKeyId.trim(),
    secretAccessKey: form.secretAccessKey.trim(),
    expectedVersion,
  };
}

/** Catches what the server would reject anyway, before a round trip. Returns null when the form can be sent. */
export function validateForm(form: ObjectStorageForm, hasSavedCredentials: boolean): string | null {
  if (form.provider === 'r2' && !R2_ACCOUNT_ID.test(form.accountId.trim())) {
    return 'Enter your 32-character Cloudflare account ID';
  }
  if (form.provider === 's3' && !form.endpoint.trim()) return 'Enter the endpoint URL';
  if (form.provider === 'aws' && !form.region.trim()) return 'Enter the AWS region, such as eu-west-1';
  if (!form.bucket.trim()) return 'Enter the bucket name';

  const hasKey = !!form.accessKeyId.trim();
  const hasSecret = !!form.secretAccessKey.trim();
  if (!hasSavedCredentials && (!hasKey || !hasSecret)) return 'Enter the access key ID and secret access key';
  if (hasSecret && !hasKey) return 'Enter the access key ID that belongs to this secret';
  return null;
}

const CHECK_LABELS: Record<string, string> = {
  connect: 'Reach the bucket',
  list: 'List objects',
  write: 'Write an object',
  read: 'Read it back',
  delete: 'Delete it',
  'existing-files': 'Find existing files',
};

export function checkLabel(step: string): string {
  return CHECK_LABELS[step] ?? step;
}
