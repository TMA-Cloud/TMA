import { describe, expect, it } from 'vitest';

import { publishedMessages, setRedisDown } from '../../mocks/redis.mock.js';
import {
  EventTypes,
  getConnectionStats,
  getUserEventsChannel,
  publishFileEvent,
  publishFileEventsBatch,
  subscribeToFileEvents,
  unsubscribeFromFileEvents,
} from '../../../services/fileEvents.js';

const USER = 'user000000000001';
const OTHER = 'user000000000002';

describe('getUserEventsChannel', () => {
  it('scopes the channel to one user, which is what keeps events private', () => {
    expect(getUserEventsChannel(USER)).toBe(`file:events:${USER}`);
    expect(getUserEventsChannel(USER)).not.toBe(getUserEventsChannel(OTHER));
  });
});

describe('EventTypes', () => {
  it('namespaces every event type', () => {
    for (const value of Object.values(EventTypes)) {
      expect(value).toMatch(/^(file|folder)\.[a-z_]+$/);
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(EventTypes);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('publishFileEvent', () => {
  it('publishes to the target user channel', async () => {
    await publishFileEvent(EventTypes.FILE_UPLOADED, { fileId: 'f1' }, USER);
    const [message] = publishedMessages();
    expect(message.channel).toBe(`file:events:${USER}`);
  });

  it('wraps the payload with a type and timestamp', async () => {
    await publishFileEvent(EventTypes.FILE_RENAMED, { fileId: 'f1', name: 'new.txt' }, USER);
    const event = JSON.parse(publishedMessages()[0].message);
    expect(event.type).toBe(EventTypes.FILE_RENAMED);
    expect(event.data).toEqual({ fileId: 'f1', name: 'new.txt' });
    expect(new Date(event.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('falls back to the userId carried in the payload', async () => {
    await publishFileEvent(EventTypes.FILE_DELETED, { fileId: 'f1', userId: OTHER });
    expect(publishedMessages()[0].channel).toBe(`file:events:${OTHER}`);
  });

  it('prefers the explicit userId over the one in the payload', async () => {
    await publishFileEvent(EventTypes.FILE_DELETED, { userId: OTHER }, USER);
    expect(publishedMessages()[0].channel).toBe(`file:events:${USER}`);
  });

  it('drops the event when no user can be determined', async () => {
    await publishFileEvent(EventTypes.FILE_DELETED, { fileId: 'f1' });
    expect(publishedMessages()).toHaveLength(0);
  });

  it('is a no-op when Redis is unavailable', async () => {
    setRedisDown(true);
    await expect(publishFileEvent(EventTypes.FILE_UPLOADED, { fileId: 'f1' }, USER)).resolves.toBeUndefined();
    expect(publishedMessages()).toHaveLength(0);
  });
});

describe('publishFileEventsBatch', () => {
  it('publishes every event in the batch', async () => {
    await publishFileEventsBatch([
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'f1' }, userId: USER },
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'f2' }, userId: USER },
    ]);
    expect(publishedMessages()).toHaveLength(2);
  });

  it('routes each event to its own user channel', async () => {
    await publishFileEventsBatch([
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'f1' }, userId: USER },
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'f2' }, userId: OTHER },
    ]);
    const channels = publishedMessages().map(m => m.channel);
    expect(new Set(channels)).toEqual(new Set([`file:events:${USER}`, `file:events:${OTHER}`]));
  });

  it('preserves order within a single user channel', async () => {
    await publishFileEventsBatch([
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'first' }, userId: USER },
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'second' }, userId: USER },
    ]);
    const ids = publishedMessages().map(m => JSON.parse(m.message).data.fileId);
    expect(ids).toEqual(['first', 'second']);
  });

  it('skips entries with no resolvable user but still publishes the rest', async () => {
    await publishFileEventsBatch([
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'orphan' } },
      { eventType: EventTypes.FILE_UPLOADED, eventData: { fileId: 'good' }, userId: USER },
    ]);
    expect(publishedMessages()).toHaveLength(1);
  });

  it('accepts an empty batch', async () => {
    await expect(publishFileEventsBatch([])).resolves.toBeUndefined();
  });

  it('accepts a non-array without throwing', async () => {
    await expect(publishFileEventsBatch(null)).resolves.toBeUndefined();
  });

  it('is a no-op when Redis is unavailable', async () => {
    setRedisDown(true);
    await publishFileEventsBatch([{ eventType: EventTypes.FILE_UPLOADED, eventData: {}, userId: USER }]);
    expect(publishedMessages()).toHaveLength(0);
  });
});

describe('subscribeToFileEvents', () => {
  it('delivers events published to the subscribed user', async () => {
    const received = [];
    const subscriber = await subscribeToFileEvents(USER, event => received.push(event));
    expect(subscriber).not.toBeNull();

    await publishFileEvent(EventTypes.FILE_UPLOADED, { fileId: 'f1' }, USER);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: EventTypes.FILE_UPLOADED, data: { fileId: 'f1' } });

    await unsubscribeFromFileEvents(subscriber, USER);
  });

  it("does not deliver another user's events", async () => {
    const received = [];
    const subscriber = await subscribeToFileEvents(USER, event => received.push(event));
    await publishFileEvent(EventTypes.FILE_UPLOADED, { fileId: 'f1' }, OTHER);
    expect(received).toHaveLength(0);
    await unsubscribeFromFileEvents(subscriber, USER);
  });

  it('refuses to subscribe without a user id', async () => {
    expect(await subscribeToFileEvents(null, () => {})).toBeNull();
  });

  it('returns null when Redis is unavailable', async () => {
    setRedisDown(true);
    expect(await subscribeToFileEvents(USER, () => {})).toBeNull();
  });

  it('tracks the connection in the stats', async () => {
    const before = getConnectionStats().activeConnections;
    const subscriber = await subscribeToFileEvents(USER, () => {});
    expect(getConnectionStats().activeConnections).toBe(before + 1);
    await unsubscribeFromFileEvents(subscriber, USER);
    expect(getConnectionStats().activeConnections).toBe(before);
  });
});

describe('unsubscribeFromFileEvents', () => {
  it('tolerates a null subscriber', async () => {
    await expect(unsubscribeFromFileEvents(null)).resolves.toBeUndefined();
  });

  it('is safe to call twice', async () => {
    const subscriber = await subscribeToFileEvents(USER, () => {});
    await unsubscribeFromFileEvents(subscriber, USER);
    await expect(unsubscribeFromFileEvents(subscriber, USER)).resolves.toBeUndefined();
  });

  it('stops delivering events after unsubscribing', async () => {
    const received = [];
    const subscriber = await subscribeToFileEvents(USER, e => received.push(e));
    await unsubscribeFromFileEvents(subscriber, USER);
    await publishFileEvent(EventTypes.FILE_UPLOADED, { fileId: 'f1' }, USER);
    expect(received).toHaveLength(0);
  });
});

describe('getConnectionStats', () => {
  it('reports a hard connection ceiling', () => {
    const stats = getConnectionStats();
    expect(stats.maxConnections).toBeGreaterThan(0);
    expect(stats.activeConnections).toBeGreaterThanOrEqual(0);
  });
});
