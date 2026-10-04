/** True when the key belongs to a field the user is typing in. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || !!target.closest('input, textarea, select');
}

/** True when the focused control already acts on Enter itself. */
export function isActivatableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('button, a[href], summary, [role="button"], [role="menuitem"], [role="link"]');
}

/**
 * True when list keys (arrows, letters, Enter) belong to the file list: it has
 * focus, or nothing does, as on page load. As in Explorer, once Tab moves focus
 * to another control the arrows stop moving through files.
 */
export function isFileListFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target === document.body || !!target.closest('.file-list');
}

/** DOM id of a file row, so the list can name its active item in `aria-activedescendant`. */
export function fileItemDomId(fileId: string): string {
  return `file-item-${fileId}`;
}

/** Modals, viewers and menus own the keyboard while they are open. */
export function isOverlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"]');
}
