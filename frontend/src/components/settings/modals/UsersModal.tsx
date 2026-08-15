import React, { useMemo, useState } from 'react';
import { Loader2, Shield, ShieldCheck, HardDrive, Edit2, Check, X, CornerDownRight, RotateCcw } from 'lucide-react';
import { format } from 'date-fns';
import { Modal } from '../../ui/Modal';
import { NumberInput } from '../../ui/NumberInput';
import { ModalCountHeader } from '../components/ModalCountHeader';
import { updateUserStorageLimit, type UserSummary } from '../../../utils/api';
import { useToast } from '../../../hooks/useToast';
import { formatFileSize } from '../../../utils/fileUtils';
import { bytesToNumberAndUnit, numberAndUnitToBytes, type StorageUnit } from '../../../utils/storageUtils';

export interface UsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  usersList: UserSummary[];
  loadingUsersList: boolean;
  usersListError: string | null;
  onRefresh: () => void;
  onStorageUpdated?: () => void;
  currentUserId?: string;
}

/**
 * Format signup date using date-fns for consistent formatting
 * @param isoString - ISO date string
 * @returns Formatted date string or "Unknown" if invalid
 */
const formatSignupDate = (isoString: string) => {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return 'Unknown';
    }
    return format(date, "MMM d, yyyy 'at' h:mm a");
  } catch {
    return 'Unknown';
  }
};

/**
 * Group sub-users under the account they belong to, so the admin list reads as
 * one row per account with its extra logins nested underneath. A sub-user whose
 * owner is missing from the list is treated as top-level rather than dropped.
 */
const groupByAccount = (users: UserSummary[]) => {
  const owners = users.filter(u => !u.parentUserId);
  const ownerIds = new Set(owners.map(u => u.id));
  const orphans = users.filter(u => u.parentUserId && !ownerIds.has(u.parentUserId));

  return [...owners, ...orphans].map(owner => ({
    owner,
    subUsers: users.filter(u => u.parentUserId === owner.id),
  }));
};

export const UsersModal: React.FC<UsersModalProps> = ({
  isOpen,
  onClose,
  usersList,
  loadingUsersList,
  usersListError,
  onRefresh,
  onStorageUpdated,
  currentUserId,
}) => {
  const { showToast } = useToast();
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [editUnit, setEditUnit] = useState<StorageUnit>('GB');
  const [updating, setUpdating] = useState<string | null>(null);

  const accounts = useMemo(() => groupByAccount(usersList), [usersList]);
  const subUserCount = usersList.length - accounts.length;

  // Flattened for rendering: each account row is immediately followed by its
  // sub-user rows, which carry a reference to the owner they belong to.
  const rows = useMemo(
    () =>
      accounts.flatMap(({ owner, subUsers }) => [
        { user: owner, owner: null as UserSummary | null },
        ...subUsers.map(subUser => ({ user: subUser, owner })),
      ]),
    [accounts]
  );

  const mfaStats = useMemo(() => {
    if (usersList.length === 0) {
      return { enabled: 0, disabled: 0, percentage: 0 };
    }
    const enabled = usersList.filter(u => u.mfaEnabled).length;
    const disabled = usersList.length - enabled;
    const percentage = Math.round((enabled / usersList.length) * 100);
    return { enabled, disabled, percentage };
  }, [usersList]);

  const handleEditLimit = (user: UserSummary) => {
    const currentLimit = user.storageLimit;
    // Convert bytes to number and unit for editing
    // Ensure we convert to number in case it comes as string from API
    // Also handle edge cases where value might be 0, empty string, or invalid
    let limitAsNumber: number | null = null;
    if (currentLimit !== null && currentLimit !== undefined) {
      const num = Number(currentLimit);
      limitAsNumber = Number.isFinite(num) && num > 0 ? num : null;
    }
    const { number, unit } = bytesToNumberAndUnit(limitAsNumber);
    setEditValue(number);
    setEditUnit(unit);
    setEditingUserId(user.id);
  };

  const handleCancelEdit = () => {
    setEditingUserId(null);
    setEditValue('');
    setEditUnit('GB');
  };

  /** Clearing the limit hands the account back the default (actual disk space). */
  const handleResetLimit = async (userId: string) => {
    setUpdating(userId);
    try {
      await updateUserStorageLimit(userId, null);
      showToast('Storage limit reset to disk size', 'success');
      handleCancelEdit();
      onRefresh();
      if (userId === currentUserId) onStorageUpdated?.();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to reset storage limit', 'error');
    } finally {
      setUpdating(null);
    }
  };

  const handleSaveLimit = async (user: UserSummary) => {
    const userId = user.id;
    const trimmed = editValue.trim();

    // An empty box means "no limit" — same as pressing Reset.
    if (trimmed === '') {
      await handleResetLimit(userId);
      return;
    }

    // Validate and convert to bytes
    const bytes = numberAndUnitToBytes(trimmed, editUnit);
    if (bytes === null) {
      showToast('Enter a positive number', 'error');
      return;
    }

    // Additional validation: ensure bytes is within reasonable range
    if (bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) {
      showToast('Limit must be between 1 byte and 9 PB', 'error');
      return;
    }

    // A limit under what the account already stores would strand it over quota
    // with no way to upload again. The server rejects this too; checking here
    // saves a round trip and names the number the admin has to clear.
    const used = user.storageUsed ?? 0;
    if (bytes < used) {
      showToast(`Limit can't be below the ${formatFileSize(used)} already stored`, 'error');
      return;
    }

    setUpdating(userId);
    try {
      await updateUserStorageLimit(userId, bytes);
      showToast('Storage limit updated', 'success');
      handleCancelEdit();
      onRefresh();
      if (userId === currentUserId) onStorageUpdated?.();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to update storage limit', 'error');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Registered Users" size="xl">
      <div className="space-y-4">
        <ModalCountHeader
          count={accounts.length}
          singular="account"
          countSuffix={subUserCount > 0 ? ` · ${subUserCount} sub-user${subUserCount === 1 ? '' : 's'}` : ' total'}
          emptyText="No users to display yet"
          loading={loadingUsersList}
          onRefresh={onRefresh}
        />

        {usersList.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">MFA Statistics</h3>
            </div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-gray-600 dark:text-gray-400 mb-1">Enabled</div>
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-green-600 dark:text-green-400" />
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{mfaStats.enabled}</span>
                </div>
              </div>
              <div>
                <div className="text-gray-600 dark:text-gray-400 mb-1">Disabled</div>
                <div className="flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  <span className="font-semibold text-gray-900 dark:text-gray-100">{mfaStats.disabled}</span>
                </div>
              </div>
              <div>
                <div className="text-gray-600 dark:text-gray-400 mb-1">Adoption</div>
                <div className="font-semibold text-gray-900 dark:text-gray-100">{mfaStats.percentage}%</div>
              </div>
            </div>
          </div>
        )}

        {usersListError && <p className="text-sm text-red-500 dark:text-red-400">{usersListError}</p>}

        {loadingUsersList ? (
          <p className="text-center text-gray-600 dark:text-gray-300 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading users...
          </p>
        ) : usersList.length === 0 ? (
          <p className="text-center text-gray-600 dark:text-gray-300">
            Once people sign up, their accounts will appear here!
          </p>
        ) : (
          <div className="overflow-x-auto max-h-[60vh]">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Storage</th>
                  <th className="py-2 pr-4 font-medium">Limit</th>
                  <th className="py-2 pr-4 font-medium">MFA</th>
                  <th className="py-2 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ user: listedUser, owner }) => {
                  const isEditing = editingUserId === listedUser.id;
                  const isUpdating = updating === listedUser.id;
                  const used = listedUser.storageUsed ?? 0;
                  const total = listedUser.storageTotal ?? 0;
                  const percentage = total > 0 ? Math.round((used / total) * 100) : 0;
                  const ownerLabel = owner ? owner.name || owner.email : '';

                  return (
                    <tr
                      key={listedUser.id}
                      className={`border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-[#f9f9f7]/80 dark:hover:bg-gray-900/40 transition-colors ${
                        owner ? 'bg-slate-100/50 dark:bg-gray-900/25' : ''
                      }`}
                    >
                      <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">
                        {owner ? (
                          <span className="flex items-center gap-1.5 pl-4">
                            <CornerDownRight className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
                            <span>{listedUser.name || 'Unnamed'}</span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-slate-200 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300">
                              Sub-user
                            </span>
                          </span>
                        ) : (
                          listedUser.name || 'Unnamed'
                        )}
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{listedUser.email}</td>
                      <td className="py-2 pr-4">
                        {owner ? (
                          <span className="text-xs text-gray-500 dark:text-gray-400">Shares {ownerLabel}</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <HardDrive className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                            <div className="flex flex-col">
                              <span className="text-gray-900 dark:text-gray-100 font-medium">
                                {formatFileSize(used)}
                              </span>
                              {total > 0 && (
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  {percentage}% of {formatFileSize(total)}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {/* Sub-users store into the owner's account, so their own
                            storage limit is never consulted — show the inherited
                            one instead of offering an edit that does nothing. */}
                        {owner ? (
                          <span className="text-xs text-gray-500 dark:text-gray-400">Inherited</span>
                        ) : isEditing ? (
                          <div className="flex items-center gap-1">
                            <NumberInput
                              value={editValue}
                              onValueChange={setEditValue}
                              maxLength={15}
                              placeholder="0"
                              className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-20 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                              disabled={isUpdating}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  handleSaveLimit(listedUser);
                                } else if (e.key === 'Escape') {
                                  handleCancelEdit();
                                }
                              }}
                              autoFocus
                            />
                            <select
                              value={editUnit}
                              onChange={e => setEditUnit(e.target.value as 'MB' | 'GB' | 'TB')}
                              disabled={isUpdating}
                              className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-[#ffffff] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
                            >
                              <option value="MB">MB</option>
                              <option value="GB">GB</option>
                              <option value="TB">TB</option>
                            </select>
                            <button
                              onClick={() => handleSaveLimit(listedUser)}
                              disabled={isUpdating}
                              className="p-1 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 rounded disabled:opacity-50 transition-colors"
                              title="Save"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleResetLimit(listedUser.id)}
                              disabled={isUpdating}
                              className="p-1 text-gray-500 dark:text-gray-400 hover:bg-slate-200/70 dark:hover:bg-slate-700/40 rounded disabled:opacity-50 transition-colors"
                              title="Reset to default"
                              aria-label="Reset storage limit to default"
                            >
                              <RotateCcw className="w-4 h-4" />
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              disabled={isUpdating}
                              className="p-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50 transition-colors"
                              title="Cancel"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-gray-700 dark:text-gray-300 text-xs">
                              {listedUser.storageLimit === null ||
                              listedUser.storageLimit === undefined ||
                              listedUser.storageLimit === 0
                                ? 'Default'
                                : formatFileSize(Number(listedUser.storageLimit))}
                            </span>
                            <button
                              onClick={() => handleEditLimit(listedUser)}
                              disabled={isUpdating}
                              className="p-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded disabled:opacity-50 transition-colors"
                              title="Edit storage limit"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {listedUser.mfaEnabled ? (
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
                      <td className="py-2 text-gray-600 dark:text-gray-400">
                        {formatSignupDate(listedUser.createdAt)}
                      </td>
                    </tr>
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
