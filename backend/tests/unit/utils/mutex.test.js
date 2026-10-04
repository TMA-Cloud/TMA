import { describe, expect, it } from 'vitest';

import { userOperationLock } from '../../../utils/mutex.js';

const delay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

describe('userOperationLock', () => {
  it('returns the operation result', async () => {
    expect(await userOperationLock('u1', async () => 'done')).toBe('done');
  });

  it('serialises operations for one user', async () => {
    const events = [];
    const task = label => async () => {
      events.push(`${label}:start`);
      await delay(10);
      events.push(`${label}:end`);
    };

    await Promise.all([userOperationLock('u1', task('a')), userOperationLock('u1', task('b'))]);

    // Whichever ran first must have finished before the other started.
    expect(events[1]).toBe(events[0].replace(':start', ':end'));
    expect(events).toHaveLength(4);
  });

  it('lets operations for different users run concurrently', async () => {
    let concurrent = 0;
    let peak = 0;
    const task = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await delay(20);
      concurrent--;
    };

    await Promise.all([userOperationLock('u1', task), userOperationLock('u2', task)]);

    expect(peak).toBe(2);
  });

  it('releases the lock when the operation throws', async () => {
    await expect(
      userOperationLock('u-boom', async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');

    // A second caller must not be blocked by the failed one.
    await expect(userOperationLock('u-boom', async () => 'recovered')).resolves.toBe('recovered');
  });

  it('preserves FIFO order across a queue of waiters', async () => {
    const order = [];
    await Promise.all(
      [1, 2, 3, 4].map(n =>
        userOperationLock('u-queue', async () => {
          order.push(n);
          await delay(1);
        })
      )
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
