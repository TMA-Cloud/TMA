import { describe, expect, it } from 'vitest';

import {
  parseDatabaseUrl,
  redisDatabase,
  requireUrl,
  withDatabase,
  withPassword,
} from '../../../utils/connectionUrl.js';

describe('parseDatabaseUrl', () => {
  it('reads every part of a postgres URL', () => {
    expect(parseDatabaseUrl('postgresql://tma:s3cret@db.internal:6543/tma_cloud_storage')).toMatchObject({
      user: 'tma',
      password: 's3cret',
      host: 'db.internal',
      port: 6543,
      database: 'tma_cloud_storage',
    });
  });

  it('accepts the postgres:// scheme and leaves the port to pg when absent', () => {
    const config = parseDatabaseUrl('postgres://u:p@localhost/app');
    expect(config.host).toBe('localhost');
    expect(config.port).toBeUndefined();
  });

  it('percent-decodes credentials and database names', () => {
    const config = parseDatabaseUrl('postgresql://us%40er:p%40ss%2Fw%3Ard@h/my%20db');
    expect(config.user).toBe('us@er');
    expect(config.password).toBe('p@ss/w:rd');
    expect(config.database).toBe('my db');
  });

  it('reads IPv6 hosts and query parameters', () => {
    const config = parseDatabaseUrl('postgresql://u:p@[::1]:5432/app?application_name=tma&connect_timeout=5');
    expect(config.host).toBe('::1');
    expect(config.application_name).toBe('tma');
    expect(config.connect_timeout).toBe('5');
  });

  it('follows libpq sslmode semantics', () => {
    expect(parseDatabaseUrl('postgresql://u:p@h/app?sslmode=disable').ssl).toBe(false);
    // libpq's require encrypts without verifying the certificate.
    expect(parseDatabaseUrl('postgresql://u:p@h/app?sslmode=require').ssl).toEqual({ rejectUnauthorized: false });
    expect(parseDatabaseUrl('postgresql://u:p@h/app?sslmode=verify-full').ssl).toEqual({});
    expect(parseDatabaseUrl('postgresql://u:p@h/app').ssl).toBeUndefined();
  });

  it('lets the URL choose uselibpqcompat itself', () => {
    expect(() => parseDatabaseUrl('postgresql://u:p@h/app?uselibpqcompat=true&sslmode=require')).not.toThrow();
  });

  it('requires a URL and a database name', () => {
    expect(() => parseDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
    expect(() => parseDatabaseUrl('postgresql://u:p@h:5432')).toThrow(/must name a database/);
  });
});

describe('redisDatabase', () => {
  it('reads the index from the path, defaulting to 0', () => {
    expect(redisDatabase('redis://:pw@redis:6379/15')).toBe(15);
    expect(redisDatabase('rediss://redis:6380')).toBe(0);
    expect(redisDatabase('redis://redis:6379/')).toBe(0);
  });

  it('requires a URL', () => {
    expect(() => redisDatabase('')).toThrow(/REDIS_URL is not set/);
  });
});

describe('withDatabase', () => {
  it('swaps the database and keeps everything else', () => {
    expect(withDatabase('postgresql://u:p@h:5432/prod?sslmode=require', 'tma_cloud_test')).toBe(
      'postgresql://u:p@h:5432/tma_cloud_test?sslmode=require'
    );
    expect(withDatabase('redis://:pw@redis:6379/0', '15')).toBe('redis://:pw@redis:6379/15');
    expect(withDatabase('redis://redis:6379', '15')).toBe('redis://redis:6379/15');
  });
});

describe('withPassword', () => {
  it('replaces the password and keeps the rest', () => {
    expect(withPassword('postgresql://tma:old@h:5432/app?sslmode=disable', 'new123')).toBe(
      'postgresql://tma:new123@h:5432/app?sslmode=disable'
    );
  });

  it('percent-encodes characters the URL reserves', () => {
    const url = withPassword('postgresql://tma:old@h/app', 'a@b:c/d%e');
    expect(parseDatabaseUrl(url).password).toBe('a@b:c/d%e');
  });
});

describe('requireUrl', () => {
  it('returns a set value', () => {
    expect(requireUrl('REDIS_URL', 'redis://x')).toBe('redis://x');
  });
});
