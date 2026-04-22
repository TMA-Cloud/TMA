import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../utils/authFetch';

export interface StorageUsage {
  used: number;
  total: number | null;
  free: number | null;
}

export function useStorageUsage() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUsage = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/user/storage`);
      if (res.ok) {
        const data = await res.json();
        setUsage({ used: data.used, total: data.total, free: data.free });
      }
    } catch {
      // Error handled silently - storage usage will show as unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  return { usage, loading, refresh: loadUsage };
}
