import React from 'react';
import { Copy, Check, Loader2, Shield, ShieldCheck, ShieldOff, AlertTriangle } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { useMfa } from './useMfa';
import { formatCooldownTime } from './mfaBackupCodes';

interface MfaModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const MfaModal: React.FC<MfaModalProps> = ({ isOpen, onClose }) => {
  const {
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
  } = useMfa({ isOpen, onClose });

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Two-Factor Authentication"
        size="md"
        initialFocusRef={
          step === 'verify' || step === 'disable' ? (mfaInputRef as React.RefObject<HTMLElement>) : undefined
        }
      >
        {step === 'status' && (
          <div className="space-y-6">
            <div className="flex items-center gap-4 p-5 rounded-xl bg-[var(--accent-fill)] border border-blue-200/50 dark:border-blue-800/50">
              <div
                className={`p-3 rounded-full ${mfaEnabled ? 'bg-green-100 dark:bg-green-900/30' : 'bg-gray-100 dark:bg-gray-800'}`}
              >
                {mfaEnabled ? (
                  <ShieldCheck className="w-6 h-6 text-green-600 dark:text-green-400" />
                ) : (
                  <ShieldOff className="w-6 h-6 text-gray-600 dark:text-gray-400" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">Status</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {mfaEnabled ? 'Enabled' : 'Disabled'}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {mfaEnabled ? (
                <>
                  {remainingCodesCount !== null && (
                    <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
                      <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                        Backup Codes: {remainingCodesCount} remaining
                      </p>
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                        Save these codes in a safe place. Each code can only be used once.
                      </p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <button
                      onClick={handleRegenerateBackupCodes}
                      disabled={regenerating || (cooldownRemaining !== null && cooldownRemaining > 0)}
                      className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 hover:bg-[#f9f9f7] dark:hover:bg-gray-800 rounded-xl transition-colors font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {regenerating ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Regenerating...
                        </>
                      ) : cooldownRemaining !== null && cooldownRemaining > 0 ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Cooldown: {formatCooldownTime(cooldownRemaining)}
                        </>
                      ) : (
                        'Regenerate Backup Codes'
                      )}
                    </button>
                    {cooldownRemaining !== null && cooldownRemaining > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
                        Please wait before regenerating backup codes again
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setStep('disable')}
                    className="w-full px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md flex items-center justify-center gap-2"
                  >
                    <ShieldOff className="w-4 h-4" />
                    Disable MFA
                  </button>
                </>
              ) : (
                <button
                  onClick={handleSetup}
                  disabled={loading}
                  className="w-full px-4 py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Setting up...
                    </>
                  ) : (
                    <>
                      <Shield className="w-4 h-4" />
                      Enable MFA
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {step === 'verify' && (
          <div className="space-y-6">
            <div className="text-center space-y-4">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Scan this QR code with your authenticator app:
              </p>
              {qrCode && (
                <div className="flex justify-center p-4 bg-[#ffffff] dark:bg-gray-900 rounded-xl border-2 border-gray-200 dark:border-gray-700">
                  <img src={qrCode} alt="MFA QR Code" className="w-56 h-56" />
                </div>
              )}
              {secret && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">Or enter this code manually:</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-4 py-3 bg-[#f9f9f7] dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-xs font-mono text-gray-900 dark:text-gray-100 break-all">
                      {secret}
                    </code>
                    <button
                      onClick={copySecret}
                      className="p-3 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors border border-gray-300 dark:border-gray-600"
                      title="Copy secret"
                    >
                      {copied ? (
                        <Check className="w-5 h-5 text-green-500" />
                      ) : (
                        <Copy className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Enter verification code:
              </label>
              <input
                ref={mfaInputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={verificationCode}
                onChange={e => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                className="w-full px-4 py-4 border-2 border-gray-300 dark:border-gray-600 rounded-xl bg-[#f9f9f7] dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-center text-3xl tracking-[0.5em] font-mono font-semibold"
                placeholder="000000"
                autoFocus
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                Enter the 6-digit code from your authenticator app
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => {
                  setStep('status');
                  setVerificationCode('');
                }}
                className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-[#f9f9f7] dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleVerify}
                disabled={loading || verificationCode.length !== 6}
                className="flex-1 px-4 py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  'Verify & Enable'
                )}
              </button>
            </div>
          </div>
        )}

        {step === 'disable' && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">
                Enter your verification code to disable MFA
              </p>
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                This will remove the extra security layer from your account.
              </p>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Verification code:</label>
              <input
                ref={mfaInputRef}
                type="text"
                maxLength={9}
                value={verificationCode}
                onChange={e => {
                  const value = e.target.value.toUpperCase();
                  // Allow dashes for readability (e.g., ABCD-EFGH) but strip them before storing
                  const filtered = value.replace(/[^A-Z0-9-]/g, '');
                  const withoutDashes = filtered.replace(/-/g, '');
                  setVerificationCode(withoutDashes);
                }}
                className="w-full px-4 py-4 border-2 border-gray-300 dark:border-gray-600 rounded-xl bg-[#f9f9f7] dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 text-center text-2xl tracking-[0.3em] font-mono font-semibold uppercase"
                placeholder="000000 or ABCD-EFGH"
                autoFocus
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                Enter the 6-digit code from your authenticator app or an 8-character backup code (dashes allowed for
                readability)
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => {
                  setStep('status');
                  setVerificationCode('');
                }}
                className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-[#f9f9f7] dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleDisable}
                disabled={loading || (verificationCode.length !== 6 && verificationCode.length !== 8)}
                className="flex-1 px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Disabling...
                  </>
                ) : (
                  'Disable MFA'
                )}
              </button>
            </div>
          </div>
        )}

        {step === 'sessionPrompt' && (
          <div className="space-y-6">
            <div className="text-center space-y-3">
              <div className="flex justify-center">
                <div className="p-4 rounded-full bg-blue-100 dark:bg-blue-900/30">
                  <Shield className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                </div>
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">Sign out of other sessions?</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                For security, sign out of all other active sessions?
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handleSkipSessions}
                disabled={revokingSessions}
                className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-[#f9f9f7] dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"
              >
                Skip
              </button>
              <button
                onClick={handleRevokeOtherSessions}
                disabled={revokingSessions}
                className="flex-1 px-4 py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {revokingSessions ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Signing out...
                  </>
                ) : (
                  'Yes'
                )}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Confirmation Dialog for Regenerating Backup Codes */}
      <Modal
        isOpen={showConfirmDialog}
        onClose={() => setShowConfirmDialog(false)}
        title="Regenerate Backup Codes"
        size="sm"
      >
        <div className="space-y-6">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 p-3 rounded-full bg-amber-100 dark:bg-amber-900/30">
              <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">Are you sure?</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This will invalidate all existing backup codes and generate new ones. Make sure you've saved your
                current backup codes before proceeding.
              </p>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setShowConfirmDialog(false)}
              disabled={regenerating}
              className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-[#f9f9f7] dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmRegenerateBackupCodes}
              disabled={regenerating || (cooldownRemaining !== null && cooldownRemaining > 0)}
              className="flex-1 px-4 py-3 bg-[var(--warning)] hover:opacity-90 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {regenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Regenerating...
                </>
              ) : cooldownRemaining !== null && cooldownRemaining > 0 ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Wait: {formatCooldownTime(cooldownRemaining)}
                </>
              ) : (
                'Regenerate'
              )}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};
