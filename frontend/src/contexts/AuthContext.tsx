import { createContext, useContext } from 'react';

/**
 * Capability keys the server enforces. Mirrors backend/utils/permissions.js —
 * the human-readable catalog itself is fetched from the API, this union just
 * gives call sites autocomplete and a compile-time typo check.
 */
export type AccountPermission =
  'files.download' | 'files.upload' | 'files.edit' | 'files.delete' | 'files.trash' | 'files.share';

export interface User {
  id: string;
  email: string;
  name?: string;
  created_at?: string;
  mfa_enabled?: boolean;
  /** True when this login is a sub-user of another account. */
  isSubUser?: boolean;
  /** Capabilities granted to this login. Owners receive the full set. */
  permissions?: string[];
}

export interface AuthContextType {
  user: User | null;
  loading: boolean;
  /** True when the signed-in user is a sub-user of another account. */
  isSubUser: boolean;
  /** Whether the signed-in user holds a given capability. */
  can: (permission: AccountPermission) => boolean;
  login: (
    email: string,
    password: string,
    mfaCode?: string
  ) => Promise<{ success: boolean; requiresMfa?: boolean; message?: string }>;
  signup: (email: string, password: string, name?: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

// Moved AuthProvider to ./AuthProvider.tsx to keep this file hook-only
