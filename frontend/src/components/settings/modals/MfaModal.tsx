import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Copy,
  Check,
  Loader2,
  Shield,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { useToast } from "../../../hooks/useToast";
import { Modal } from "../../ui/Modal";
import {
  getMfaStatus,
  setupMfa,
  verifyAndEnableMfa,
  disableMfa,
  revokeOtherSessions,
} from "../../../utils/api";

interface MfaModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type MfaStep = "status" | "setup" | "verify" | "disable" | "sessionPrompt";

export const MfaModal: React.FC<MfaModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const [step, setStep] = useState<MfaStep>("status");
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [revokingSessions, setRevokingSessions] = useState(false);
  const mfaInputRef = useRef<HTMLInputElement>(null);

  const loadMfaStatus = useCallback(async () => {
    try {
      const status = await getMfaStatus();
      setMfaEnabled(status.enabled);
      setStep("status");
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
    }
  }, [isOpen, loadMfaStatus]);

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

      if (result.shouldPromptSessions) {
        setStep("sessionPrompt");
      } else {
        setStep("status");
        showToast("MFA enabled successfully", "success");
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
    if (!verificationCode || verificationCode.length !== 6) {
      showToast("Please enter a 6-digit code to disable MFA", "error");
      return;
    }

    setLoading(true);
    try {
      const result = await disableMfa(verificationCode);
      setMfaEnabled(false);
      setVerificationCode("");

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

  return (
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
              <button
                onClick={() => setStep("disable")}
                className="w-full px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl transition-all duration-200 font-medium shadow-sm hover:shadow-md flex items-center justify-center gap-2"
              >
                <ShieldOff className="w-4 h-4" />
                Disable MFA
              </button>
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
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={verificationCode}
              onChange={(e) =>
                setVerificationCode(e.target.value.replace(/\D/g, ""))
              }
              className="w-full px-4 py-4 border-2 border-gray-300 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 text-center text-3xl tracking-[0.5em] font-mono font-semibold"
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
              onClick={handleDisable}
              disabled={loading || verificationCode.length !== 6}
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
  );
};
