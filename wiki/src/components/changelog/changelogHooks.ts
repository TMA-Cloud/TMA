import { useEffect, useMemo, useState } from "react";
import type {
  ChangelogIndexManifest,
  ChangelogReleaseFile,
} from "./changelogTypes";
import { buildIndexUrl, normalizeBaseUrl } from "./changelogRepo";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  return (await res.json()) as T;
}

export function useChangelogIndex(baseUrl: string) {
  const normalizedBaseUrl = useMemo(() => normalizeBaseUrl(baseUrl), [baseUrl]);
  const [index, setIndex] = useState<ChangelogIndexManifest | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!normalizedBaseUrl) return;

    setError("");
    setIndex(null);
    setLoading(true);

    let cancelled = false;
    fetchJson<ChangelogIndexManifest>(buildIndexUrl(normalizedBaseUrl))
      .then((idx) => {
        if (cancelled) return;
        setIndex(idx);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedBaseUrl]);

  return { index, loading, error };
}

export function useChangelogRelease(
  baseUrl: string,
  releaseFile: string | null,
) {
  const normalizedBaseUrl = useMemo(() => normalizeBaseUrl(baseUrl), [baseUrl]);
  const [release, setRelease] = useState<ChangelogReleaseFile | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!normalizedBaseUrl || !releaseFile) {
      setRelease(null);
      setError("");
      setLoading(false);
      return;
    }

    setError("");
    setRelease(null);
    setLoading(true);

    let cancelled = false;
    const releaseUrl = `${normalizedBaseUrl}${releaseFile}`;

    fetchJson<ChangelogReleaseFile>(releaseUrl)
      .then((r) => {
        if (cancelled) return;
        setRelease(r);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedBaseUrl, releaseFile]);

  return { release, loading, error };
}
