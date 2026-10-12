// Names are stored as the user's OS wrote them. Like Nextcloud's defaults, only what
// no filesystem can hold in one component is refused; Windows-only limits such as
// "?" or "CON" are handled where a name meets Windows (ZIP, desktop app, Cloud Drive).

const MAX_ITEM_NAME_LENGTH = 255;

// "/" and "\" are separators on some OS, and control characters break headers and logs.
// eslint-disable-next-line no-control-regex -- Intentional: refuse control characters
const FORBIDDEN_IN_NAME = /[/\\\x00-\x1F\x7F]/;

/** Whether `name` can be stored as one file or folder name. */
function isValidItemName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || name.length > MAX_ITEM_NAME_LENGTH) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  return !FORBIDDEN_IN_NAME.test(name);
}

// eslint-disable-next-line no-control-regex -- Intentional: control characters are not portable
const NOT_PORTABLE = /[\\/:*?"<>|\x00-\x1F]/g;

/**
 * One path segment that every common OS can extract, as browsers do for
 * downloads: Windows-reserved characters become "_" and trailing dots and
 * spaces, which Windows drops, are removed.
 */
function portableName(name) {
  const portable = String(name)
    .replace(NOT_PORTABLE, '_')
    .replace(/[. ]+$/, '');
  return portable === '' || portable === '.' || portable === '..' ? '_' : portable;
}

export { MAX_ITEM_NAME_LENGTH, isValidItemName, portableName };
