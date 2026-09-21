import { logger } from '../config/logger.js';
import { linkItemsToParentShares, parentHasShares } from '../models/share.model.js';
import { getBoss } from './auditLogger/queue.js';
import { SHARE_LINK_QUEUE } from './backgroundQueue.js';

/**
 * Auto-link newly added items into any share their parent folder belongs to.
 *
 * When a folder is shared, its whole subtree is a member of the share
 * (`share_link_files`). Anything dropped into that folder afterwards has to be
 * added too, or it stays invisible on the public link.
 *
 * Nothing in the upload/create response depends on the result, and the link
 * itself is a recursive subtree write, so the request only pays for one indexed
 * lookup and a durable handoff. The job is idempotent (`ON CONFLICT DO NOTHING`)
 * and keyed per account so a burst of uploads serializes instead of racing.
 *
 * Failures are logged, not thrown: a share-link hiccup must never fail the
 * upload/create that triggered it.
 *
 * @param {Object}   params
 * @param {string}   params.ownerId  Owning account id.
 * @param {string|null} params.parentId  Folder the items were added to.
 * @param {string[]} params.itemIds  Ids of the new items (files or folders).
 */
async function linkNewItemsToParentShare({ ownerId, parentId, itemIds }) {
  if (!parentId || !Array.isArray(itemIds) || itemIds.length === 0) return;

  try {
    if (!(await parentHasShares(parentId, ownerId))) return;

    const boss = getBoss();
    if (boss) {
      await boss.send(SHARE_LINK_QUEUE, { ownerId, parentId, itemIds }, { singletonKey: ownerId });
      return;
    }

    // Degraded mode: link inline rather than leaving the items off the link.
    logger.warn({ ownerId, parentId }, 'Share-link queue unavailable; linking inline');
    await applyShareLinking({ ownerId, parentId, itemIds });
  } catch (err) {
    logger.warn({ err, ownerId, parentId }, 'Failed to auto-link new items to parent share');
  }
}

/** Execute one share-linking job. Safe to retry. */
async function applyShareLinking({ ownerId, parentId, itemIds }) {
  const mappings = await linkItemsToParentShares(itemIds, ownerId);
  if (mappings.length === 0) return { linked: 0, shares: 0 };

  const shares = new Set(mappings.map(item => item.share_id)).size;
  logger.debug({ ownerId, parentId, roots: itemIds.length, shares }, 'Auto-linked items to parent share');
  return { linked: mappings.length, shares };
}

export { linkNewItemsToParentShare, applyShareLinking };
