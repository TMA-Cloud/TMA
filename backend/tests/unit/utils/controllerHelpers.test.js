import { describe, expect, it } from 'vitest';

import { validateFileIds, validateParentId, validateSingleId } from '../../../utils/controllerHelpers.js';

const ID = 'abcDEF1234567890';
const ID2 = 'zyxWVU0987654321';

describe('validateParentId', () => {
  it('treats a missing parent as the root folder', () => {
    expect(validateParentId({ body: {} })).toEqual({ valid: true, parentId: null, error: null });
  });

  it('treats an explicit null parent as the root folder', () => {
    expect(validateParentId({ body: { parentId: null } })).toEqual({ valid: true, parentId: null, error: null });
  });

  it('treats an empty-string parent as the root folder', () => {
    expect(validateParentId({ body: { parentId: '' } }).parentId).toBeNull();
  });

  it('returns a valid parent id unchanged', () => {
    expect(validateParentId({ body: { parentId: ID } })).toEqual({ valid: true, parentId: ID, error: null });
  });

  it('rejects a malformed parent id', () => {
    const result = validateParentId({ body: { parentId: 'nope' } });
    expect(result).toEqual({ valid: false, parentId: null, error: 'Invalid parent ID' });
  });

  it('reads from the query string when asked', () => {
    const req = { body: { parentId: ID }, query: { parentId: ID2 } };
    expect(validateParentId(req, 'query').parentId).toBe(ID2);
  });

  it('defaults to the body when the source is not "query"', () => {
    const req = { body: { parentId: ID }, query: { parentId: ID2 } };
    expect(validateParentId(req, 'body').parentId).toBe(ID);
    expect(validateParentId(req).parentId).toBe(ID);
  });
});

describe('validateFileIds', () => {
  it('returns a validated list', () => {
    expect(validateFileIds({ body: { ids: [ID, ID2] } })).toEqual({ valid: true, ids: [ID, ID2], error: null });
  });

  it('rejects an empty list', () => {
    expect(validateFileIds({ body: { ids: [] } })).toEqual({ valid: false, ids: null, error: 'Invalid ids array' });
  });

  it('rejects a missing ids field', () => {
    expect(validateFileIds({ body: {} }).valid).toBe(false);
  });

  it('rejects the whole batch if any id is malformed', () => {
    expect(validateFileIds({ body: { ids: [ID, '../../etc/passwd'] } }).valid).toBe(false);
  });

  it('rejects a single id sent outside an array', () => {
    expect(validateFileIds({ body: { ids: ID } }).valid).toBe(false);
  });
});

describe('validateSingleId', () => {
  it('reads the id route param by default', () => {
    expect(validateSingleId({ params: { id: ID } })).toEqual({ valid: true, id: ID, error: null });
  });

  it('reads a named param', () => {
    const req = { params: { fileId: ID } };
    expect(validateSingleId(req, 'fileId').id).toBe(ID);
  });

  it('reads from the body when asked', () => {
    const req = { params: {}, body: { id: ID } };
    expect(validateSingleId(req, 'id', 'body').id).toBe(ID);
  });

  it('names the offending parameter in the error', () => {
    const result = validateSingleId({ params: { fileId: 'bad' } }, 'fileId');
    expect(result).toEqual({ valid: false, id: null, error: 'Invalid fileId' });
  });

  it('rejects a missing param', () => {
    expect(validateSingleId({ params: {} }).valid).toBe(false);
  });
});
