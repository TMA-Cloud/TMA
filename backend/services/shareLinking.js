import { logger } from '../config/logger.js';
import { setShared } from '../models/file.model.js';
import { addFilesToShare, getShareIdsContainingFolder } from '../models/share.model.js';

/**
 * Auto-link newly added items into any share their parent folder belongs to.
 *
 * When a folder is shared, its whole subtree is a member of the share
 * (`share_link_files`). Anything dropped into that folder afterwards has to be
 * added too, or it stays invisible on the public link. This does that in one
 * step, and only when the parent is actually shared, so the common
 * (unshared) case costs a single indexed lookup.
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
    const shareIds = await getShareIdsContainingFolder(parentId, ownerId);
    if (shareIds.length === 0) return;

    // setShared marks the items (and their subtrees) shared and returns the
    // recursive id list, which is exactly the set to add to each share.
    const treeIds = await setShared(itemIds, true, ownerId);
    if (treeIds.length === 0) return;

    for (const shareId of shareIds) {
      await addFilesToShare(shareId, treeIds);
    }

    logger.debug(
      { ownerId, parentId, count: treeIds.length, shares: shareIds.length },
      'Auto-linked items to parent share'
    );
  } catch (err) {
    logger.warn({ err, ownerId, parentId }, 'Failed to auto-link new items to parent share');
  }
}

export { linkNewItemsToParentShare };
