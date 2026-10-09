import React, { useState } from 'react';
import { Clock, History } from 'lucide-react';
import { useToast } from '../../../hooks/useToast';
import { NumberInput } from '../../ui/NumberInput';
import type { ActivitySettings } from '../../../utils/api';
import { ConfigSectionHeader } from '../components/ConfigSectionHeader';
import { SettingsField, SettingsFormActions } from '../components/SettingsField';
import { useActivitySettings } from '../hooks/useActivitySettings';
import {
  ACCESS_TIME_FLUSH_RANGE,
  ACCESS_TIME_WINDOW_RANGE,
  SESSION_IDLE_DAYS_RANGE,
  describeAccessTime,
  formatIdleDays,
  parseWholeNumber,
} from './activitySettingsForm';

const CARD_CLASS =
  'rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3 transition-all duration-200 hover:border-blue-500/30 dark:hover:border-blue-500/30';
const INPUT_CLASS =
  'mt-1 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-[var(--surface-raised)] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed';

interface CardProps {
  settings: ActivitySettings | null;
  loading: boolean;
}

const SessionTimeoutCard: React.FC<
  CardProps & { saving: boolean; onSave: (days: number) => Promise<boolean | undefined> }
> = ({ settings, loading, saving, onSave }) => {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState('');

  const toggle = () => {
    if (!open && settings) setDays(String(settings.sessionIdleDays));
    setOpen(!open);
  };

  const save = async () => {
    const parsed = parseWholeNumber(days, SESSION_IDLE_DAYS_RANGE, 'Session timeout');
    if (!parsed.ok) return showToast(parsed.error, 'error');
    if (await onSave(parsed.value)) setOpen(false);
  };

  return (
    <div className={CARD_CLASS}>
      <ConfigSectionHeader
        icon={Clock}
        title="Session Timeout"
        description="Sign people out after this long without using the app"
        isConfigured={!!settings}
        loading={loading}
        saving={saving}
        isCollapsed={!open}
        isEditing={open}
        hasLoadedSettings={!!settings}
        editLabel="session timeout"
        onEdit={toggle}
        status={settings ? { text: formatIdleDays(settings.sessionIdleDays), tone: 'neutral' } : undefined}
      />
      {open && (
        <form className="mt-4 space-y-4" autoComplete="off" onSubmit={event => event.preventDefault()}>
          <SettingsField
            htmlFor="session-idle-days"
            label="Days without activity"
            description={`${SESSION_IDLE_DAYS_RANGE.min} to ${SESSION_IDLE_DAYS_RANGE.max} days. Using the app restarts the count, so an active person is never signed out. A shorter timeout applies to existing sessions right away.`}
          >
            <NumberInput
              id="session-idle-days"
              decimal={false}
              maxLength={3}
              value={days}
              onValueChange={setDays}
              disabled={saving}
              className={INPUT_CLASS}
            />
          </SettingsField>
          <SettingsFormActions onCancel={() => setOpen(false)} onSave={save} saving={saving} disabled={saving} />
        </form>
      )}
    </div>
  );
};

type AccessSave = (input: {
  enabled: boolean;
  windowMinutes: number;
  flushSeconds: number;
}) => Promise<boolean | undefined>;

const AccessTimeCard: React.FC<CardProps & { saving: boolean; onSave: AccessSave }> = ({
  settings,
  loading,
  saving,
  onSave,
}) => {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [windowMinutes, setWindowMinutes] = useState('');
  const [flushSeconds, setFlushSeconds] = useState('');

  const toggle = () => {
    if (!open && settings) {
      setEnabled(settings.accessTimeTracking);
      setWindowMinutes(String(settings.accessTimeWindowMinutes));
      setFlushSeconds(String(settings.accessTimeFlushSeconds));
    }
    setOpen(!open);
  };

  const save = async () => {
    const windowValue = parseWholeNumber(windowMinutes, ACCESS_TIME_WINDOW_RANGE, 'Update window');
    if (!windowValue.ok) return showToast(windowValue.error, 'error');
    const flush = parseWholeNumber(flushSeconds, ACCESS_TIME_FLUSH_RANGE, 'Write interval');
    if (!flush.ok) return showToast(flush.error, 'error');
    if (await onSave({ enabled, windowMinutes: windowValue.value, flushSeconds: flush.value })) setOpen(false);
  };

  return (
    <div className={CARD_CLASS}>
      <ConfigSectionHeader
        icon={History}
        title="Last Opened Tracking"
        description="Record when files and folders were last opened"
        isConfigured={!!settings}
        loading={loading}
        saving={saving}
        isCollapsed={!open}
        isEditing={open}
        hasLoadedSettings={!!settings}
        editLabel="last opened tracking"
        onEdit={toggle}
        status={
          settings
            ? {
                text: describeAccessTime(settings.accessTimeTracking, settings.accessTimeWindowMinutes),
                tone: settings.accessTimeTracking ? 'neutral' : 'warning',
              }
            : undefined
        }
      />
      {open && (
        <form className="mt-4 space-y-4" autoComplete="off" onSubmit={event => event.preventDefault()}>
          <SettingsField
            label="Tracking"
            description="Turned off, the Recent list and Last opened dates stop changing."
          >
            <label className="mt-1 inline-flex items-center gap-2 type-footnote text-gray-900 dark:text-gray-100">
              <input
                type="checkbox"
                checked={enabled}
                onChange={event => setEnabled(event.target.checked)}
                disabled={saving}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Record when items are opened
            </label>
          </SettingsField>
          <SettingsField
            htmlFor="access-time-window"
            label="Update window (minutes)"
            description={`${ACCESS_TIME_WINDOW_RANGE.min} to ${ACCESS_TIME_WINDOW_RANGE.max}. An item opened again within this time keeps its stored date, which saves a database write per open. 0 records every open.`}
          >
            <NumberInput
              id="access-time-window"
              decimal={false}
              maxLength={4}
              value={windowMinutes}
              onValueChange={setWindowMinutes}
              disabled={saving || !enabled}
              className={INPUT_CLASS}
            />
          </SettingsField>
          <SettingsField
            htmlFor="access-time-flush"
            label="Write interval (seconds)"
            description={`${ACCESS_TIME_FLUSH_RANGE.min} to ${ACCESS_TIME_FLUSH_RANGE.max}. Opens are collected in memory and written together this often.`}
          >
            <NumberInput
              id="access-time-flush"
              decimal={false}
              maxLength={3}
              value={flushSeconds}
              onValueChange={setFlushSeconds}
              disabled={saving || !enabled}
              className={INPUT_CLASS}
            />
          </SettingsField>
          <SettingsFormActions onCancel={() => setOpen(false)} onSave={save} saving={saving} disabled={saving} />
        </form>
      )}
    </div>
  );
};

/** Session timeout and last-opened tracking, for the first user. */
export const ActivitySettingsSection: React.FC<{ canConfigure: boolean }> = ({ canConfigure }) => {
  const { settings, loading, saveSessionTimeout, savingSession, saveAccessTime, savingAccess } =
    useActivitySettings(canConfigure);

  if (!canConfigure) return null;

  return (
    <>
      <SessionTimeoutCard settings={settings} loading={loading} saving={savingSession} onSave={saveSessionTimeout} />
      <AccessTimeCard settings={settings} loading={loading} saving={savingAccess} onSave={saveAccessTime} />
    </>
  );
};
