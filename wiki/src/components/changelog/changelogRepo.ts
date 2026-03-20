import type { ChangelogIndexManifest } from "./changelogTypes";

export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function buildIndexUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}index.json`;
}

export function semverParse(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const v = (version || "").trim().replace(/^v/i, "");
  const parts = v.split(".");
  if (parts.length < 1) return null;
  // Handle pre-release suffixes like `2.0.6-beta` by parsing leading digits.
  const major = parseInt(parts[0] ?? "0", 10);
  const minor = parseInt(parts[1] ?? "0", 10);
  const patch = parseInt(parts[2] ?? "0", 10);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  )
    return null;
  return { major, minor, patch };
}

export function semverCompare(a: string, b: string): number {
  const pa = semverParse(a);
  const pb = semverParse(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export function chooseLatestByMajor(
  index: ChangelogIndexManifest,
  major: number,
) {
  const candidates = index.versions.filter(
    (v) => semverParse(v.version)?.major === major,
  );
  candidates.sort((x, y) => semverCompare(y.version, x.version));
  return candidates[0];
}
