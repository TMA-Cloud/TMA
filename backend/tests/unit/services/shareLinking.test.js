import { beforeEach, describe, expect, it, vi } from 'vitest';

const parentHasShares = vi.fn();
const linkItemsToParentShares = vi.fn();
const getBoss = vi.fn();

vi.mock('../../../models/share.model.js', () => ({
  parentHasShares: (...args) => parentHasShares(...args),
  linkItemsToParentShares: (...args) => linkItemsToParentShares(...args),
}));

vi.mock('../../../services/auditLogger/queue.js', () => ({
  getBoss: (...args) => getBoss(...args),
}));

const { linkNewItemsToParentShare } = await import('../../../services/shareLinking.js');
const { SHARE_LINK_QUEUE } = await import('../../../services/backgroundQueue.js');

const OWNER = 'user000000000001';
const PARENT = 'file000000000001';
const ITEMS = ['file000000000002'];

describe('linkNewItemsToParentShare', () => {
  let send;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue('job-1');
    parentHasShares.mockReset().mockResolvedValue(true);
    linkItemsToParentShares.mockReset().mockResolvedValue([{ root_id: ITEMS[0], share_id: 'share1' }]);
    getBoss.mockReset().mockReturnValue({ send });
  });

  it('costs one indexed lookup when the parent is not shared', async () => {
    parentHasShares.mockResolvedValue(false);

    await linkNewItemsToParentShare({ ownerId: OWNER, parentId: PARENT, itemIds: ITEMS });

    expect(parentHasShares).toHaveBeenCalledWith(PARENT, OWNER);
    expect(send).not.toHaveBeenCalled();
    expect(linkItemsToParentShares).not.toHaveBeenCalled();
  });

  it('hands the subtree write to the worker, keyed per account', async () => {
    await linkNewItemsToParentShare({ ownerId: OWNER, parentId: PARENT, itemIds: ITEMS });

    expect(send).toHaveBeenCalledWith(
      SHARE_LINK_QUEUE,
      { ownerId: OWNER, parentId: PARENT, itemIds: ITEMS },
      { singletonKey: OWNER }
    );
    expect(linkItemsToParentShares).not.toHaveBeenCalled();
  });

  it('links inline rather than dropping the items when the queue is down', async () => {
    getBoss.mockReturnValue(null);

    await linkNewItemsToParentShare({ ownerId: OWNER, parentId: PARENT, itemIds: ITEMS });

    expect(linkItemsToParentShares).toHaveBeenCalledWith(ITEMS, OWNER);
  });

  it('never fails the upload that triggered it', async () => {
    send.mockRejectedValue(new Error('queue exploded'));

    await expect(
      linkNewItemsToParentShare({ ownerId: OWNER, parentId: PARENT, itemIds: ITEMS })
    ).resolves.toBeUndefined();
  });

  it('does nothing at the root, where there is no parent share to join', async () => {
    await linkNewItemsToParentShare({ ownerId: OWNER, parentId: null, itemIds: ITEMS });

    expect(parentHasShares).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
