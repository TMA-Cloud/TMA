import { useState, useEffect, useCallback } from "react";

export interface StorageUsage {
  used: number;
  total: number;
  free: number;
}

export function useStorageUsage() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUsage = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL}/api/user/storage`,
        {
          credentials: "include",
        },
      );
      if (res.ok) {
        const data = await res.json();
        setUsage({ used: data.used, total: data.total, free: data.free });
      }
    } catch (err) {
      console.error("Failed to fetch storage usage", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  return { usage, loading, refresh: loadUsage };
}
