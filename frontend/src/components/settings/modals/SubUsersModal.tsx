import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Shield, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { format } from 'date-fns';
import { Modal } from '../../ui/Modal';
import { ModalCountHeader } from '../components/ModalCountHeader';
import { PermissionChecklist } from '../components/PermissionChecklist';
import { PasswordInput } from '../../auth/PasswordInput';
import type { PermissionDefinition, SubUser } from '../../../utils/api';
import { MIN_PASSWORD_LENGTH, validateNewPassword } from '../../../utils/authValidation';

export interface SubUsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  subUsers: SubUser[];
  availablePermissions: PermissionDefinition[];
  loading: boolean;
  error: string | null;
  creating: boolean;
  updatingId: string | null;
  deletingId: string | null;
  onRefresh: () => void;
  onCreate: (payload: { email: string; password: string; name: string; permissions: string[] }) => Promise<boolean>;
  onUpdatePermissions: (id: string, permissions: string[]) => Promise<boolean>;
  onRemove: (id: string) => void;
}

const formatJoined = (isoString: string) => {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return format(date, "MMM d, yyyy 'at' h:mm a");
  } catch {
    return 'Unknown';
  }
};

/** Short summary of a grant set, e.g. "Download, Modify" or "Full access". */
const summarisePermissions = (granted: string[], available: PermissionDefinition[]) => {
  if (available.length > 0 && granted.length === available.length) return 'Full access';
  if (granted.length === 0) return 'Browse only';
  const labels = available.filter(p => granted.includes(p.key)).map(p => p.label);
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
};

export const SubUsersModal: React.FC<SubUsersModalProps> = ({
  isOpen,
  onClose,
  subUsers,
  availablePermissions,
  loading,
  error,
  creating,
  updatingId,
  deletingId,
  onRefresh,
  onCreate,
  onUpdatePermissions,
  onRemove,
}) => {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [newPermissions, setNewPermissions] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);

  // Which row has its permission checklist open, and the edits made to it so
  // far. Draft state is kept separate so closing without saving discards.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftPermissions, setDraftPermissions] = useState<string[]>([]);

  const allKeys = availablePermissions.map(p => p.key);

  const openForm = () => {
    // Full access is the common case for a colleague who needs the same files.
    setNewPermissions(allKeys);
    setShowForm(true);
  };

  const resetForm = () => {
    setName('');
    setEmail('');
    setPassword('');
    setShowPassword(false);
    setNewPermissions([]);
    setFormError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Enter a name for sub-user.');
      return;
    }
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFormError('Enter an email address for the new sub-user.');
      return;
    }
    // Mirrors the server-side minimum so the request is not wasted.
    const passwordError = validateNewPassword(password);
    if (passwordError) {
      setFormError(passwordError);
      return;
    }

    const created = await onCreate({
      email: trimmedEmail,
      password,
      name: trimmedName,
      permissions: newPermissions,
    });

    if (created) {
      resetForm();
      setShowForm(false);
    }
  };

  const toggleExpanded = (subUser: SubUser) => {
    if (expandedId === subUser.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(subUser.id);
    setDraftPermissions(subUser.permissions);
  };

  const handleSavePermissions = async (subUser: SubUser) => {
    const saved = await onUpdatePermissions(subUser.id, draftPermissions);
    if (saved) {
      setExpandedId(null);
    }
  };

  const inputClass =
    'border border-slate-200/80 dark:border-slate-600/80 rounded-2xl px-4 py-3 w-full bg-white/70 dark:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-[#007aff]/35 focus:border-[#007aff]/40 text-slate-800 dark:text-slate-100 placeholder-slate-400 transition-all duration-300 ease-out text-base';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Sub-users" size="xl">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Sub-users have their own login credentials while sharing your account's files and storage. Creating individual
          sub-users ensures actions are accurately tracked in the audit log, and lets you assign specific permissions
          per person.
        </p>

        <ModalCountHeader
          count={subUsers.length}
          singular="sub-user"
          emptyText="No sub-users yet"
          loading={loading}
          onRefresh={onRefresh}
        />

        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}

        {showForm ? (
          <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-slate-200/60 dark:border-slate-700/40 bg-white/60 dark:bg-gray-900/50 p-5 space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5" htmlFor="su-name">
                  Name
                </label>
                <input
                  id="su-name"
                  className={inputClass}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Jane Doe"
                  maxLength={100}
                  disabled={creating}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5" htmlFor="su-email">
                  Email
                </label>
                <input
                  id="su-email"
                  type="email"
                  className={inputClass}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="jane@example.com"
                  autoComplete="off"
                  maxLength={254}
                  disabled={creating}
                  required
                />
              </div>
            </div>

            <div className="sm:max-w-[50%]">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5" htmlFor="su-pass">
                Password
              </label>
              <PasswordInput
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete="new-password"
                showPassword={showPassword}
                onTogglePassword={() => setShowPassword(v => !v)}
              />
            </div>

            <PermissionChecklist
              idPrefix="su-new"
              available={availablePermissions}
              value={newPermissions}
              onChange={setNewPermissions}
              disabled={creating}
            />

            {formError && <p className="text-sm text-red-500 dark:text-red-400">{formError}</p>}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={creating}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl border border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                <span>Create sub-user</span>
              </button>
              <button
                type="button"
                disabled={creating}
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
                className="px-4 py-2.5 rounded-2xl text-gray-600 dark:text-gray-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/40 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={openForm}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl border border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            <span>Add sub-user</span>
          </button>
        )}

        {loading && subUsers.length === 0 ? (
          <p className="text-center text-gray-600 dark:text-gray-300 flex items-center justify-center gap-2 py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading sub-users...
          </p>
        ) : subUsers.length === 0 ? (
          <p className="text-center text-gray-600 dark:text-gray-300 py-4">
            Add sub-users to give colleagues their own login to the same files and storage
          </p>
        ) : (
          <div className="overflow-x-auto max-h-[50vh]">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Permissions</th>
                  <th className="py-2 pr-4 font-medium">MFA</th>
                  <th className="py-2 pr-4 font-medium">Added</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {subUsers.map(subUser => {
                  const isUpdating = updatingId === subUser.id;
                  const isDeleting = deletingId === subUser.id;
                  const busy = isUpdating || isDeleting;
                  const isExpanded = expandedId === subUser.id;

                  return (
                    <React.Fragment key={subUser.id}>
                      <tr className="border-b border-gray-100 dark:border-gray-800 hover:bg-[#f9f9f7]/80 dark:hover:bg-gray-900/40 transition-colors">
                        <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{subUser.name || 'Unnamed'}</td>
                        <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{subUser.email}</td>
                        <td className="py-2 pr-4">
                          <button
                            onClick={() => toggleExpanded(subUser)}
                            disabled={busy}
                            aria-expanded={isExpanded}
                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50 transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                            <span>{summarisePermissions(subUser.permissions, availablePermissions)}</span>
                            <span className="text-gray-400">
                              ({subUser.permissions.length}/{availablePermissions.length})
                            </span>
                          </button>
                        </td>
                        <td className="py-2 pr-4">
                          {subUser.mfaEnabled ? (
                            <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400">
                              <ShieldCheck className="w-4 h-4" />
                              <span className="text-xs font-medium">Enabled</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                              <Shield className="w-4 h-4" />
                              <span className="text-xs font-medium">Disabled</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-gray-600 dark:text-gray-400">
                          {formatJoined(subUser.createdAt)}
                        </td>
                        <td className="py-2">
                          {confirmingRemoveId === subUser.id ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => {
                                  onRemove(subUser.id);
                                  setConfirmingRemoveId(null);
                                }}
                                disabled={busy}
                                className="px-2 py-1 text-xs rounded border border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-colors"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setConfirmingRemoveId(null)}
                                disabled={busy}
                                className="px-2 py-1 text-xs rounded text-gray-600 dark:text-gray-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/40 disabled:opacity-50 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmingRemoveId(subUser.id)}
                              disabled={busy}
                              title="Remove sub-user"
                              aria-label={`Remove ${subUser.email}`}
                              className="p-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50 transition-colors"
                            >
                              {isDeleting ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Trash2 className="w-4 h-4" />
                              )}
                            </button>
                          )}
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="border-b border-gray-100 dark:border-gray-800 bg-slate-50/60 dark:bg-gray-900/30">
                          <td colSpan={6} className="p-4">
                            <PermissionChecklist
                              idPrefix={`su-${subUser.id}`}
                              available={availablePermissions}
                              value={draftPermissions}
                              onChange={setDraftPermissions}
                              disabled={isUpdating}
                            />
                            <div className="flex items-center gap-3 mt-3">
                              <button
                                onClick={() => handleSavePermissions(subUser)}
                                disabled={isUpdating}
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-60 disabled:cursor-not-allowed text-sm transition-colors"
                              >
                                {isUpdating && <Loader2 className="w-4 h-4 animate-spin" />}
                                <span>Save permissions</span>
                              </button>
                              <button
                                onClick={() => setExpandedId(null)}
                                disabled={isUpdating}
                                className="px-3 py-2 rounded-xl text-sm text-gray-600 dark:text-gray-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/40 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
};
