import { logger } from '../../config/logger.js';
import { getFileByToken, getFolderContentsByShare, getSharedFolderPath } from '../../models/share.model.js';
import { recordAccess } from '../../services/accessTracker.js';
import { shareAccessed } from '../../services/auditLogger.js';
import { sendError } from '../../utils/response.js';

import { renderErrorPage, renderFolderPage, renderFilePage } from './share.utils.js';

/**
 * Handle shared file/folder access
 * For folders: displays HTML listing
 * For files: downloads the file
 */
async function handleShared(req, res) {
  try {
    const { token } = req.params;
    const file = await getFileByToken(token);

    if (!file) {
      return renderErrorPage(res, 404, 'Link not found', 'This share link does not exist or has been removed.');
    }
    if (file.expired) {
      return renderErrorPage(res, 410, 'Link expired', 'This share link has expired and is no longer available.');
    }

    // Log share access (anonymous users)
    await shareAccessed(token, req);

    // A visitor on a share link is still a reader, so the item counts as
    // accessed on the owner's account. Who did the reading stays in the audit
    // trail; this timestamp only records that it happened.
    recordAccess(file.id, file.userId);
    logger.info({ shareToken: token, fileId: file.id, fileType: file.type }, 'Share link accessed');

    if (file.type === 'folder') {
      const items = await getFolderContentsByShare(token, file.id);
      res.send(
        renderFolderPage(items, token, {
          heading: file.name,
          trail: [{ id: file.id, name: file.name }],
          zipHref: `/s/${token}/zip`,
        })
      );
    } else {
      // A single-file share shows a landing page; its Download button streams
      // the bytes through /s/:token/file/:id.
      res.send(renderFilePage(file, token));
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Browse into a subfolder of a shared folder.
 * The folder must belong to this share and be a folder; the breadcrumb path
 * doubles as the access check (empty path ⇒ not a shared folder ⇒ 404).
 */
async function browseSharedFolder(req, res) {
  try {
    const { token, id: folderId } = req.params;
    const file = await getFileByToken(token);

    if (!file) {
      return renderErrorPage(res, 404, 'Link not found', 'This share link does not exist or has been removed.');
    }
    if (file.expired) {
      return renderErrorPage(res, 410, 'Link expired', 'This share link has expired and is no longer available.');
    }

    const trail = await getSharedFolderPath(token, folderId);
    const current = trail[trail.length - 1];
    if (!current || current.type !== 'folder') {
      return renderErrorPage(res, 404, 'Not found', 'The requested item was not found in this share.');
    }

    await shareAccessed(token, req);
    recordAccess(folderId, file.userId);
    logger.info({ shareToken: token, folderId }, 'Share subfolder browsed');

    const items = await getFolderContentsByShare(token, folderId);
    res.send(
      renderFolderPage(items, token, {
        heading: current.name,
        trail,
        zipHref: `/s/${token}/file/${folderId}`,
      })
    );
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

export { handleShared, browseSharedFolder };
