import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Copy,
  Check,
  Loader2,
  Shield,
  ShieldCheck,
  ShieldOff,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "../../../hooks/useToast";
import { Modal } from "../../ui/Modal";
import { useAuth } from "../../../contexts/AuthContext";
import {
  getMfaStatus,
  setupMfa,
  verifyAndEnableMfa,
  disableMfa,
  revokeOtherSessions,
  regenerateBackupCodes,
  getBackupCodesCount,
} from "../../../utils/api";
import { ApiError } from "../../../utils/errorUtils";

interface MfaModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type MfaStep = "status" | "setup" | "verify" | "disable" | "sessionPrompt";

/**
 * Mask email address for privacy (e.g., useremail****@***.com)
 */
function maskEmail(email: string): string {
  if (!email) return "userema****@***.com";
  const parts = email.split("@");
  const localPart = parts[0];
  const domain = parts[1];

  if (!localPart || !domain) return "userema****@***.com";

  // Keep first 7 characters of local part, mask the rest
  const maskedLocal =
    localPart.length > 7
      ? localPart.substring(0, 7) + "****"
      : localPart.substring(0, Math.max(1, localPart.length - 4)) + "****";

  // Mask domain (keep only last 3 characters if available)
  const maskedDomain =
    domain.length > 3 ? "***" + domain.substring(domain.length - 3) : "***.com";

  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * Format backup codes in groups of 5 with numbered brackets
 */
function formatBackupCodes(codes: string[]): string {
  let result = "";
  for (let i = 0; i < codes.length; i++) {
    const num = i + 1;
    const padding = num < 10 ? " " : "";
    result += `[${padding}${num} ]  ${codes[i]}\n`;
    if ((i + 1) % 5 === 0 && i < codes.length - 1) {
      result += "\n";
    }
  }
  return result.trim();
}

/**
 * Format cooldown time in milliseconds to human-readable string
 */
function formatCooldownTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${seconds}s`;
}

export const MfaModal: React.FC<MfaModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [step, setStep] = useState<MfaStep>("status");
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [revokingSessions, setRevokingSessions] = useState(false);
  const [remainingCodesCount, setRemainingCodesCount] = useState<number | null>(
    null,
  );
  const [regenerating, setRegenerating] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState<number | null>(
    null,
  );
  const mfaInputRef = useRef<HTMLInputElement>(null);

  const loadMfaStatus = useCallback(async () => {
    try {
      const status = await getMfaStatus();
      setMfaEnabled(status.enabled);
      setStep("status");
      if (status.enabled) {
        try {
          const countResult = await getBackupCodesCount();
          setRemainingCodesCount(countResult.count);
        } catch {
          // Ignore if count fetch fails
        }
      }
    } catch {
      showToast("Failed to load MFA status", "error");
    }
  }, [showToast]);

  useEffect(() => {
    if (isOpen) {
      loadMfaStatus();
    } else {
      // Reset state when modal closes
      setStep("status");
      setVerificationCode("");
      setQrCode(null);
      setSecret(null);
      setRemainingCodesCount(null);
      setCooldownRemaining(null);
    }
  }, [isOpen, loadMfaStatus]);

  // Countdown timer for cooldown
  useEffect(() => {
    if (cooldownRemaining === null || cooldownRemaining <= 0) {
      setCooldownRemaining(null);
      return;
    }

    const interval = setInterval(() => {
      setCooldownRemaining((prev) => {
        if (prev === null || prev <= 0) {
          return null;
        }
        return prev - 1000;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [cooldownRemaining]);

  const handleSetup = async () => {
    setLoading(true);
    try {
      const result = await setupMfa();
      setQrCode(result.qrCode);
      setSecret(result.secret);
      setStep("verify");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to setup MFA";
      showToast(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!verificationCode || verificationCode.length !== 6) {
      showToast("Please enter a 6-digit code", "error");
      return;
    }

    setLoading(true);
    try {
      const result = await verifyAndEnableMfa(verificationCode);
      setMfaEnabled(true);
      setVerificationCode("");

      // Set remaining codes count if provided
      if (result.backupCodes && result.backupCodes.length > 0) {
        setRemainingCodesCount(result.backupCodes.length);
      }

      // Show session prompt if needed, otherwise go to status
      if (result.shouldPromptSessions) {
        setStep("sessionPrompt");
        // Download backup codes after setting step (small delay to ensure modal state is updated)
        if (result.backupCodes && result.backupCodes.length > 0) {
          setTimeout(() => {
            downloadBackupCodes(result.backupCodes!);
          }, 100);
        }
      } else {
        setStep("status");
        // Download backup codes if provided
        if (result.backupCodes && result.backupCodes.length > 0) {
          downloadBackupCodes(result.backupCodes);
          showToast(
            "MFA enabled successfully. Backup codes downloaded.",
            "success",
          );
        } else {
          showToast("MFA enabled successfully", "success");
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid verification code";
      showToast(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    if (
      !verificationCode ||
      (verificationCode.length !== 6 && verificationCode.length !== 8)
    ) {
      showToast(
        "Please enter a 6-digit TOTP code or 8-character backup code",
        "error",
      );
      return;
    }

    setLoading(true);
    try {
      const result = await disableMfa(verificationCode);
      setMfaEnabled(false);
      setVerificationCode("");
      setRemainingCodesCount(null);

      if (result.shouldPromptSessions) {
        setStep("sessionPrompt");
      } else {
        setStep("status");
        showToast("MFA disabled successfully", "success");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid verification code";
      showToast(message, "error");
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
          ? `Signed out of ${result.deletedCount} other session${result.deletedCount === 1 ? "" : "s"}`
          : "No other sessions to sign out",
        "success",
      );
      onClose();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to revoke sessions";
      showToast(message, "error");
    } finally {
      setRevokingSessions(false);
    }
  };

  const handleSkipSessions = () => {
    showToast("MFA status updated successfully", "success");
    onClose();
  };

  const copySecret = () => {
    if (secret) {
      navigator.clipboard.writeText(secret);
      setCopied(true);
      showToast("Secret copied to clipboard", "success");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadBackupCodes = (codes: string[]) => {
    const appName = "TMA Cloud";
    const maskedEmail = user?.email
      ? maskEmail(user.email)
      : "userema****@***.com";
    const now = new Date();
    const dateTime = now.toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const fileName = `mfa-backup-codes_TMA-Cloud_${dateStr}.txt`;

    const content = `Multi-Factor Authentication (MFA) Backup Codes

Application: ${appName}
Account: ${maskedEmail}
Generated: ${dateTime}

---

IMPORTANT — READ CAREFULLY

• Each backup code can be used ONLY ONCE
• Store this file in a SECURE LOCATION
• Anyone with these codes can access your account
• If this file is lost or exposed, REGENERATE CODES IMMEDIATELY

Generating new backup codes will invalidate this entire list.

---

BACKUP CODES

${formatBackupCodes(codes)}

---

HOW TO USE

If you cannot access your authenticator app:

1. Sign in with your username and password
2. When prompted for MFA, enter ONE unused backup code
3. The code will be invalid after successful use

---

Need new backup codes?
Go to: Account Settings → Security → Multi-Factor Authentication
`;

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
      showToast("Backup codes regenerated and downloaded", "success");
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to regenerate backup codes";

      // Check if error contains structured cooldown data
      if (error instanceof ApiError && error.data?.retryAfterMs) {
        setCooldownRemaining(error.data.retryAfterMs as number);
      }

      showToast(message, "error");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Multi-Factor Authentication"
        size="md"
        initialFocusRef={
          step === "verify" || step === "disable"
            ? (mfaInputRef as React.RefObject<HTMLElement>)
            : undefined
        }
      >
        {step === "status" && (
          <div className="space-y-6">
            <div className="flex items-center gap-4 p-5 rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200/50 dark:border-blue-800/50">
              <div
                className={`p-3 rounded-full ${mfaEnabled ? "bg-green-100 dark:bg-green-900/30" : "bg-gray-100 dark:bg-gray-800"}`}
              >
                {mfaEnabled ? (
                  <ShieldCheck className="w-6 h-6 text-green-600 dark:text-green-400" />
                ) : (
                  <ShieldOff className="w-6 h-6 text-gray-600 dark:text-gray-400" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Status
                </p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {mfaEnabled ? "Enabled" : "Disabled"}
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
                        Save these codes in a safe place. Each code can only be
                        used once.
                      </p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <button
                      onClick={handleRegenerateBackupCodes}
                      disabled={
                        regenerating ||
                        (cooldownRemaining !== null && cooldownRemaining > 0)
                      }
                      className="w-full px-4 py-3 border-2 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                      {regenerating ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Regenerating...
                        </>
                      ) : cooldownRemaining !== null &&
                        cooldownRemaining > 0 ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Cooldown: {formatCooldownTime(cooldownRemaining)}
                        </>
                      ) : (
                        "Regenerate Backup Codes"
                      )}
                    </button>
                    {cooldownRemaining !== null && cooldownRemaining > 0 && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
                        Please wait before regenerating backup codes again
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => setStep("disable")}
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
                  className="w-full px-4 py-3 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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

        {step === "verify" && (
          <div className="space-y-6">
            <div className="text-center space-y-4">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Scan this QR code with your authenticator app:
              </p>
              {qrCode && (
                <div className="flex justify-center p-4 bg-white dark:bg-gray-900 rounded-xl border-2 border-gray-200 dark:border-gray-700">
                  <img src={qrCode} alt="MFA QR Code" className="w-56 h-56" />
                </div>
              )}
              {secret && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                    Or enter this code manually:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-xs font-mono text-gray-900 dark:text-gray-100 break-all">
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
                onChange={(e) =>
                  setVerificationCode(e.target.value.replace(/\D/g, ""))
                }
                className="w-full px-4 py-4 border-2 border-gray-300 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-center text-3xl tracking-[0.5em] font-mono font-semibold"
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
                  setStep("status");
                  setVerificationCode("");
                }}
                className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleVerify}
                disabled={loading || verificationCode.length !== 6}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify & Enable"
                )}
              </button>
            </div>
          </div>
        )}

        {step === "disable" && (
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
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Verification code:
              </label>
              <input
                ref={mfaInputRef}
                type="text"
                maxLength={9}
                value={verificationCode}
                onChange={(e) => {
                  const value = e.target.value.toUpperCase();
                  // Allow dashes for readability (e.g., ABCD-EFGH) but strip them before storing
                  const filtered = value.replace(/[^A-Z0-9-]/g, "");
                  // Strip dashes before setting state
                  const withoutDashes = filtered.replace(/-/g, "");
                  setVerificationCode(withoutDashes);
                }}
                className="w-full px-4 py-4 border-2 border-gray-300 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 text-center text-2xl tracking-[0.3em] font-mono font-semibold uppercase"
                placeholder="000000 or ABCD-EFGH"
                autoFocus
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
                Enter the 6-digit code from your authenticator app or an
                8-character backup code (dashes allowed for readability)
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => {
                  setStep("status");
                  setVerificationCode("");
                }}
                className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleDisable}
                disabled={
                  loading ||
                  (verificationCode.length !== 6 &&
                    verificationCode.length !== 8)
                }
                className="flex-1 px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Disabling...
                  </>
                ) : (
                  "Disable MFA"
                )}
              </button>
            </div>
          </div>
        )}

        {step === "sessionPrompt" && (
          <div className="space-y-6">
            <div className="text-center space-y-3">
              <div className="flex justify-center">
                <div className="p-4 rounded-full bg-blue-100 dark:bg-blue-900/30">
                  <Shield className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                </div>
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                Sign out of other sessions?
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                For security, sign out of all other active sessions?
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={handleSkipSessions}
                disabled={revokingSessions}
                className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"
              >
                Skip
              </button>
              <button
                onClick={handleRevokeOtherSessions}
                disabled={revokingSessions}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {revokingSessions ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Signing out...
                  </>
                ) : (
                  "Yes"
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
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                Are you sure?
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This will invalidate all existing backup codes and generate new
                ones. Make sure you've saved your current backup codes before
                proceeding.
              </p>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setShowConfirmDialog(false)}
              disabled={regenerating}
              className="flex-1 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors font-medium text-gray-700 dark:text-gray-300 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmRegenerateBackupCodes}
              disabled={
                regenerating ||
                (cooldownRemaining !== null && cooldownRemaining > 0)
              }
              className="flex-1 px-4 py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
                "Regenerate"
              )}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};
