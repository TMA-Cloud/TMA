import { useCallback, useState } from 'react';
import {
  createSubUser as createSubUserRequest,
  deleteSubUser as deleteSubUserRequest,
  fetchSubUsers,
  updateSubUserPermissions as updateSubUserPermissionsRequest,
  type PermissionDefinition,
  type SubUser,
} from '../../../utils/api';
import { useToast } from '../../../hooks/useToast';

/**
 * State and actions for the account owner's sub-user list.
 *
 * The permission catalog comes from the same response as the list, so the
 * checklist always renders exactly the capabilities the server enforces.
 *
 * Only owners can reach these endpoints, so a 403 here means the signed-in user
 * is itself a sub-user — the caller simply does not render the section then.
 */
export function useSubUsers() {
  const { showToast } = useToast();
  const [subUsers, setSubUsers] = useState<SubUser[]>([]);
  const [availablePermissions, setAvailablePermissions] = useState<PermissionDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadSubUsers = useCallback(
    async (silent = false) => {
      try {
        setLoading(true);
        setError(null);
        const { subUsers: list, availablePermissions: catalog } = await fetchSubUsers();
        setSubUsers(list);
        setAvailablePermissions(catalog);
      } catch (err) {
        setError('Unable to load sub-users right now');
        if (!silent) {
          showToast(err instanceof Error ? err.message : 'Failed to load sub-users', 'error');
        }
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  const createSubUser = useCallback(
    async (payload: { email: string; password: string; name: string; permissions: string[] }) => {
      setCreating(true);
      try {
        const { subUser } = await createSubUserRequest(payload);
        setSubUsers(current => [...current, subUser]);
        showToast(`${subUser.email} can now sign in to this account`, 'success');
        return true;
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to create sub-user', 'error');
        return false;
      } finally {
        setCreating(false);
      }
    },
    [showToast]
  );

  const updatePermissions = useCallback(
    async (id: string, permissions: string[]) => {
      setUpdatingId(id);
      try {
        const { subUser } = await updateSubUserPermissionsRequest(id, permissions);
        setSubUsers(current => current.map(item => (item.id === id ? subUser : item)));
        showToast('Permissions updated', 'success');
        return true;
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to update permissions', 'error');
        return false;
      } finally {
        setUpdatingId(null);
      }
    },
    [showToast]
  );

  const removeSubUser = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        await deleteSubUserRequest(id);
        setSubUsers(current => current.filter(item => item.id !== id));
        showToast('Sub-user removed!', 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to remove sub-user', 'error');
      } finally {
        setDeletingId(null);
      }
    },
    [showToast]
  );

  return {
    subUsers,
    availablePermissions,
    loading,
    error,
    creating,
    updatingId,
    deletingId,
    loadSubUsers,
    createSubUser,
    updatePermissions,
    removeSubUser,
  };
}
