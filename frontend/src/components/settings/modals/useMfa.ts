import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../contexts/AuthContext';
import {
  disableMfa,
  getBackupCodesCount,
  getMfaStatus,
  regenerateBackupCodes,
  revokeOtherSessions,
  setupMfa,
  verifyAndEnableMfa,
} from '../../../utils/api';
import { ApiError, getErrorMessage } from '../../../utils/errorUtils';
import { copyToClipboard } from '../../../utils/clipboard';
import { downloadBlob } from '../../../utils/download';
import { buildBackupCodesFile } from './mfaBackupCodes';

export type MfaStep = 'status' | 'setup' | 'verify' | 'disable' | 'sessionPrompt';

/** All state and actions for the MFA modal; the component only renders. */
export function useMfa({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [step, setStep] = useState<MfaStep>('status');
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [revokingSessions, setRevokingSessions] = useState(false);
  const [remainingCodesCount, setRemainingCodesCount] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState<number | null>(null);
  const mfaInputRef = useRef<HTMLInputElement>(null);

  const loadMfaStatus = useCallback(async () => {
    try {
      const status = await getMfaStatus();
      setMfaEnabled(status.enabled);
      setStep('status');
      if (status.enabled) {
        try {
          const countResult = await getBackupCodesCount();
          setRemainingCodesCount(countResult.count);
        } catch {
          // Ignore if count fetch fails
        }
      }
    } catch {
      showToast('Failed to load MFA status', 'error');
    }
  }, [showToast]);

  useEffect(() => {
    if (isOpen) {
      Promise.resolve().then(loadMfaStatus);
    } else {
      Promise.resolve().then(() => {
        setStep('status');
        setVerificationCode('');
        setQrCode(null);
        setSecret(null);
        setRemainingCodesCount(null);
        setCooldownRemaining(null);
      });
    }
  }, [isOpen, loadMfaStatus]);

  // Countdown timer for cooldown
  useEffect(() => {
    if (cooldownRemaining === null || cooldownRemaining <= 0) {
      // Defer the clamp-to-null so it runs in a microtask callback
      if (cooldownRemaining !== null) Promise.resolve().then(() => setCooldownRemaining(null));
      return;
    }

    const interval = setInterval(() => {
      setCooldownRemaining(prev => {
        if (prev === null || prev <= 0) {
          return null;
        }
        return prev - 1000;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [cooldownRemaining]);

  const downloadBackupCodes = (codes: string[]) => {
    const { fileName, content } = buildBackupCodesFile(codes, user?.email);
    downloadBlob(new Blob([content], { type: 'text/plain' }), fileName);
  };

  const handleSetup = async () => {
    setLoading(true);
    try {
      const result = await setupMfa();
      if (typeof result.qrCode !== 'string' || !result.qrCode.startsWith('data:image/')) {
        throw new Error('Invalid QR code received from server');
      }
      setQrCode(result.qrCode);
      setSecret(result.secret);
      setStep('verify');
    } catch (error) {
      showToast(getErrorMessage(error, 'Failed to start MFA setup'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!verificationCode || verificationCode.length !== 6) {
      showToast('Enter the 6-digit code', 'error');
      return;
    }

    setLoading(true);
    try {
      const result = await verifyAndEnableMfa(verificationCode);
      setMfaEnabled(true);
      setVerificationCode('');

      // Set remaining codes count if provided
      if (result.backupCodes && result.backupCodes.length > 0) {
        setRemainingCodesCount(result.backupCodes.length);
      }

      // Show session prompt if needed, otherwise go to status
      if (result.shouldPromptSessions) {
        setStep('sessionPrompt');
        // Download backup codes after setting step (small delay to ensure modal state is updated)
        if (result.backupCodes && result.backupCodes.length > 0) {
          setTimeout(() => {
            downloadBackupCodes(result.backupCodes!);
          }, 100);
        }
      } else {
        setStep('status');
        // Download backup codes if provided
        if (result.backupCodes && result.backupCodes.length > 0) {
          downloadBackupCodes(result.backupCodes);
          showToast('MFA enabled — backup codes downloaded', 'success');
        } else {
          showToast('MFA enabled', 'success');
        }
      }
    } catch (error) {
      showToast(getErrorMessage(error, 'Invalid verification code'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    if (!verificationCode || (verificationCode.length !== 6 && verificationCode.length !== 8)) {
      showToast('Enter a 6-digit code or 8-character backup code', 'error');
      return;
    }

    setLoading(true);
    try {
      const result = await disableMfa(verificationCode);
      setMfaEnabled(false);
      setVerificationCode('');
      setRemainingCodesCount(null);

      if (result.shouldPromptSessions) {
        setStep('sessionPrompt');
      } else {
        setStep('status');
        showToast('MFA disabled', 'success');
      }
    } catch (error) {
      showToast(getErrorMessage(error, 'Invalid verification code'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeOtherSessions = async () => {
    setRevokingSessions(true);
    try {
      const result = await revokeOtherSessions();
      showToast(
        result.deletedCount > 0
          ? `Signed out of ${result.deletedCount} other session${result.deletedCount === 1 ? '' : 's'}`
          : 'No other sessions to sign out',
        'success'
      );
      onClose();
    } catch (error) {
      showToast(getErrorMessage(error, 'Failed to revoke sessions'), 'error');
    } finally {
      setRevokingSessions(false);
    }
  };

  const handleSkipSessions = () => {
    showToast('MFA status updated', 'success');
    onClose();
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await copyToClipboard(secret);
      setCopied(true);
      showToast('Secret copied', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Failed to copy secret', 'error');
    }
  };

  const handleRegenerateBackupCodes = () => {
    setShowConfirmDialog(true);
  };

  const confirmRegenerateBackupCodes = async () => {
    setShowConfirmDialog(false);
    setRegenerating(true);
    try {
      const result = await regenerateBackupCodes();
      setRemainingCodesCount(result.backupCodes.length);
      setCooldownRemaining(5 * 60 * 1000); // 5 minutes cooldown
      downloadBackupCodes(result.backupCodes);
      showToast('Backup codes regenerated and downloaded', 'success');
    } catch (error: unknown) {
      // Structured cooldown data drives the retry timer
      if (error instanceof ApiError && error.data?.retryAfterMs) {
        setCooldownRemaining(error.data.retryAfterMs as number);
      }

      showToast(getErrorMessage(error, 'Failed to regenerate backup codes'), 'error');
    } finally {
      setRegenerating(false);
    }
  };

  return {
    step,
    setStep,
    mfaEnabled,
    loading,
    qrCode,
    secret,
    verificationCode,
    setVerificationCode,
    copied,
    revokingSessions,
    remainingCodesCount,
    regenerating,
    showConfirmDialog,
    setShowConfirmDialog,
    cooldownRemaining,
    mfaInputRef,
    handleSetup,
    handleVerify,
    handleDisable,
    handleRevokeOtherSessions,
    handleSkipSessions,
    copySecret,
    handleRegenerateBackupCodes,
    confirmRegenerateBackupCodes,
  };
}
