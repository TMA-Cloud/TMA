import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { ConfigSectionHeader } from '../components/ConfigSectionHeader';
import { SettingsField, SettingsFormActions, SettingsReadonlyValue } from '../components/SettingsField';
import { useGoogleSignInSettings } from '../hooks/useGoogleSignInSettings';
import { redirectUriFor } from './googleSignInForm';

const INPUT_CLASS =
  'mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[var(--surface-raised)] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed';

/** The Google OAuth client that lets people sign in with Google, for the first user. */
export const GoogleSignInSection: React.FC<{ canConfigure: boolean }> = ({ canConfigure }) => {
  const { settings, loading, saveSettings, saving, removeSettings, removing } = useGoogleSignInSettings(canConfigure);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');

  if (!canConfigure) return null;

  const configured = settings?.configured === true;
  const busy = loading || saving || removing;

  const toggle = () => {
    if (!open) {
      setClientId(settings?.clientId ?? '');
      setRedirectUri(settings?.redirectUri ?? redirectUriFor(window.location.origin));
    }
    // The secret is never sent back, so the field always starts empty.
    setClientSecret('');
    setOpen(!open);
  };

  const save = async () => {
    if (await saveSettings({ clientId, clientSecret, redirectUri })) {
      setClientSecret('');
      setOpen(false);
    }
  };

  const remove = async () => {
    if (await removeSettings()) setOpen(false);
  };

  return (
    <div className="rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3 transition-all duration-200 hover:border-blue-500/30 dark:hover:border-blue-500/30">
      <ConfigSectionHeader
        icon={LogIn}
        title="Google Sign-In"
        description="Let people sign in with their Google account"
        isConfigured={configured}
        loading={loading}
        saving={saving || removing}
        isCollapsed={!open}
        isEditing={open}
        hasLoadedSettings={!!settings}
        editLabel="Google sign-in settings"
        onEdit={toggle}
        status={settings ? (configured ? { text: 'On', tone: 'success' } : { text: 'Off', tone: 'info' }) : undefined}
      />

      {open && (
        <form className="mt-4 space-y-4" autoComplete="off" onSubmit={event => event.preventDefault()}>
          <SettingsField
            label="Authorized redirect URI"
            description="In Google Cloud, create an OAuth client of type Web application and add this exact URI under Authorized redirect URIs. Google allows plain http only for localhost."
          >
            <input
              id="google-redirect-uri"
              aria-label="Authorized redirect URI"
              type="text"
              value={redirectUri}
              onChange={event => setRedirectUri(event.target.value)}
              disabled={busy}
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono`}
            />
          </SettingsField>
          <SettingsField htmlFor="google-client-id" label="Client ID" description="Ends in .apps.googleusercontent.com">
            <input
              id="google-client-id"
              type="text"
              value={clientId}
              onChange={event => setClientId(event.target.value)}
              disabled={busy}
              spellCheck={false}
              placeholder="123456789-abc123.apps.googleusercontent.com"
              data-form-type="other"
              className={`${INPUT_CLASS} font-mono`}
            />
          </SettingsField>
          <SettingsField
            htmlFor="google-client-secret"
            label="Client secret"
            description={
              configured
                ? 'Leave empty to keep the saved secret. It is stored encrypted and never shown again.'
                : 'Stored encrypted and never shown again.'
            }
          >
            <input
              id="google-client-secret"
              type="password"
              value={clientSecret}
              onChange={event => setClientSecret(event.target.value)}
              disabled={busy}
              autoComplete="new-password"
              placeholder={configured ? 'Saved' : 'GOCSPX-…'}
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
              className={`${INPUT_CLASS} font-mono`}
            />
          </SettingsField>
          {configured && settings?.updatedAt && (
            <SettingsField label="Last changed">
              <SettingsReadonlyValue value={new Date(settings.updatedAt).toLocaleString()} />
            </SettingsField>
          )}
          <p className="type-caption text-gray-500 dark:text-gray-400">
            Saving checks the client ID and secret with Google first. Accounts that sign in with Google for the first
            time are created only while signup is allowed.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {configured ? (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="px-4 py-2 type-footnote font-medium rounded-lg border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {removing ? 'Turning off...' : 'Turn off Google sign-in'}
              </button>
            ) : (
              <span />
            )}
            <SettingsFormActions
              onCancel={toggle}
              onSave={save}
              saving={saving}
              disabled={busy}
              saveLabel="Check and save"
              savingLabel="Checking..."
            />
          </div>
        </form>
      )}
    </div>
  );
};
