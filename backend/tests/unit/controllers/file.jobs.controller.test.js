import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBoss } = vi.hoisted(() => ({ getBoss: vi.fn() }));

vi.mock('../../../services/auditLogger/queue.js', () => ({ getBoss }));

const { getFileJob } = await import('../../../controllers/file/file.jobs.controller.js');

const JOB_ID = '123e4567-e89b-12d3-a456-426614174000';

function responseDouble() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(code => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(body => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

beforeEach(() => {
  getBoss.mockReset();
});

describe('file background-job status', () => {
  it('does not disclose another account job', async () => {
    getBoss.mockReturnValue({
      getJobById: vi.fn(async () => ({ id: JOB_ID, state: 'completed', data: { userId: 'another-account' } })),
    });
    const res = responseDouble();

    await getFileJob({ params: { jobId: JOB_ID }, ownerId: 'owner-account' }, res);

    expect(res.statusCode).toBe(404);
  });

  it('returns 202 while work is pending', async () => {
    getBoss.mockReturnValue({
      getJobById: vi.fn(async () => ({ id: JOB_ID, state: 'active', data: { userId: 'owner-account' } })),
    });
    const res = responseDouble();

    await getFileJob({ params: { jobId: JOB_ID }, ownerId: 'owner-account' }, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ jobId: JOB_ID, status: 'active' });
  });

  it('returns only the completed job output', async () => {
    getBoss.mockReturnValue({
      getJobById: vi.fn(async () => ({
        id: JOB_ID,
        state: 'completed',
        data: { userId: 'owner-account' },
        output: { count: 2 },
      })),
    });
    const res = responseDouble();

    await getFileJob({ params: { jobId: JOB_ID }, ownerId: 'owner-account' }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ jobId: JOB_ID, status: 'completed', result: { count: 2 } });
  });
});
