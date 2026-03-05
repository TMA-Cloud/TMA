import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Lock, AlertTriangle } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../contexts/AuthContext';
import { changePassword } from '../../../utils/api';
import { getErrorMessage } from '../../../utils/errorUtils';

interface ChangePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ChangePasswordModal: React.FC<ChangePasswordModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const { logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const currentPasswordRef = useRef<HTMLInputElement | null>(null);

  const isMountedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    if (!isOpen) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSubmitting(false);
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword || !confirmPassword) {
      showToast('Please fill in all fields', 'error');
      return;
    }
    if (newPassword.length < 6) {
      showToast('New password must be at least 6 characters long', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast('New password and confirmation do not match', 'error');
      return;
    }
    if (currentPassword === newPassword) {
      showToast('New password must be different from the current password', 'error');
      return;
    }

    let skipReset = false;
    try {
      setSubmitting(true);
      const result = await changePassword(currentPassword, newPassword);
      showToast(result.message || 'Password changed successfully. Please log in again.', 'success');
      await logout();
      skipReset = true;
      onClose();
    } catch (error) {
      showToast(getErrorMessage(error, 'Failed to change password'), 'error');
    } finally {
      if (!skipReset && isMountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Change Password"
      size="md"
      initialFocusRef={currentPasswordRef as React.RefObject<HTMLElement>}
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60">
          <div className="mt-0.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Security reminder</p>
            <p className="text-xs text-amber-800 dark:text-amber-300">
              After changing your password, you may be signed out from your devices. Use a strong, unique password that
              you do not reuse on other sites.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              htmlFor="currentPassword"
            >
              Current password
            </label>
            <input
              id="currentPassword"
              ref={currentPasswordRef}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-300 dark:border-gray-600 bg-[#dfe3ea] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" htmlFor="newPassword">
              New password
            </label>
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-300 dark:border-gray-600 bg-[#dfe3ea] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Minimum 6 characters. Avoid using easily guessable information.
            </p>
          </div>

          <div>
            <label
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              htmlFor="confirmPassword"
            >
              Confirm new password
            </label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-300 dark:border-gray-600 bg-[#dfe3ea] dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-xl border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 bg-[#dfe3ea] dark:bg-gray-800 hover:bg-[#d4d9e1] dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-sm hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Lock className="w-4 h-4" />
                Change password
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
};
