export type ChangelogIndexManifest = {
  name?: string;
  updatedAt?: string;
  latest?: string;
  versions: Array<{
    version: string;
    tag: string;
    file: string;
    date?: string;
    channel?: string;
  }>;
};

export type ChangelogReleaseFile = {
  version: string;
  tag: string;
  date?: string;
  channel?: string;
  title?: string;
  intro?: string;
  items: string[];
  spatialNotes?: string;
};
