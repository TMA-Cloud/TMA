// Pure helpers for the MFA modal: email masking, formatting, and building the
// downloadable backup-codes file.

/** Mask an email for display, e.g. useremail****@***.com. */
export function maskEmail(email: string): string {
  if (!email) return 'userema****@***.com';
  const parts = email.split('@');
  const localPart = parts[0];
  const domain = parts[1];

  if (!localPart || !domain) return 'userema****@***.com';

  const maskedLocal =
    localPart.length > 7
      ? localPart.substring(0, 7) + '****'
      : localPart.substring(0, Math.max(1, localPart.length - 4)) + '****';

  const maskedDomain = domain.length > 3 ? '***' + domain.substring(domain.length - 3) : '***.com';

  return `${maskedLocal}@${maskedDomain}`;
}

/** Format backup codes in groups of 5 with numbered brackets. */
export function formatBackupCodes(codes: string[]): string {
  let result = '';
  for (let i = 0; i < codes.length; i++) {
    const num = i + 1;
    const padding = num < 10 ? ' ' : '';
    result += `[${padding}${num} ]  ${codes[i]}\n`;
    if ((i + 1) % 5 === 0 && i < codes.length - 1) {
      result += '\n';
    }
  }
  return result.trim();
}

/** Format a cooldown in ms as m:ss (or Ns under a minute). */
export function formatCooldownTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${seconds}s`;
}

/** Build the downloadable backup-codes text file (name + contents). */
export function buildBackupCodesFile(codes: string[], userEmail?: string): { fileName: string; content: string } {
  const appName = 'TMA Cloud';
  const maskedEmail = userEmail ? maskEmail(userEmail) : 'userema****@***.com';
  const now = new Date();
  const dateTime = now.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
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

  return { fileName, content };
}
