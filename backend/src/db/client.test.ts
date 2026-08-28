import { describe, it, expect } from 'vitest';
import { createDatabaseClient, redactMongoUri, type DatabaseClientLogger } from './client';

function recordingLogger(): DatabaseClientLogger & { reasons: string[] } {
  const reasons: string[] = [];
  return { reasons, connectionFailed: ({ reason }) => reasons.push(reason) };
}

describe('redactMongoUri', () => {
  it('strips the user:password credential segment', () => {
    expect(redactMongoUri('mongodb+srv://alice:s3cr3t@cluster0.abc.mongodb.net/db')).toBe(
      'mongodb+srv://***@cluster0.abc.mongodb.net/db',
    );
    expect(redactMongoUri('mongodb://u:p@localhost:27017')).toBe('mongodb://***@localhost:27017');
  });

  it('leaves a credential-free URI untouched', () => {
    expect(redactMongoUri('mongodb://localhost:27017')).toBe('mongodb://localhost:27017');
  });
});

describe('createDatabaseClient — Requirement 1.3 (unset URI)', () => {
  it('returns a disabled handle with no log when the URI is undefined', async () => {
    const logger = recordingLogger();
    const client = await createDatabaseClient({ uri: undefined, logger });

    expect(client.enabled).toBe(false);
    expect(logger.reasons).toEqual([]);
    expect(() => client.db()).toThrow(/disabled/);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('treats a blank/whitespace URI as unset', async () => {
    const logger = recordingLogger();
    const client = await createDatabaseClient({ uri: '   ', logger });

    expect(client.enabled).toBe(false);
    expect(logger.reasons).toEqual([]);
  });
});

describe('createDatabaseClient — Requirement 1.4 (bad URI)', () => {
  it('returns a disabled handle and logs once, without crashing, for a malformed URI', async () => {
    const logger = recordingLogger();
    const client = await createDatabaseClient({ uri: 'not-a-mongo-uri', logger });

    expect(client.enabled).toBe(false);
    expect(logger.reasons).toHaveLength(1);
    expect(() => client.db()).toThrow();
  });

  it('does not leak credentials from the failing URI into the log', async () => {
    const logger = recordingLogger();
    // Rejected at construction (missing host), so the driver's own message
    // echoes the URI back — the redaction has to catch that.
    await createDatabaseClient({ uri: 'mongodb://user:hunter2@', logger });

    expect(logger.reasons).toHaveLength(1);
    for (const reason of logger.reasons) {
      expect(reason).not.toContain('hunter2');
    }
  });
});
