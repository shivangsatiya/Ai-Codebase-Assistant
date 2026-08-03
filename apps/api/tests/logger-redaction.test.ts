import pino from 'pino';
import { Writable } from 'stream';
import { REDACTED_PATHS } from '../src/utils/logger';

/**
 * Builds a real pino logger writing to an in-memory stream, using the
 * exact same REDACTED_PATHS the real application logger uses - not a
 * hand-copied duplicate list. If the real redaction config ever changes,
 * these tests immediately reflect that change rather than silently
 * testing a stale copy.
 */
function createCapturingLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[Redacted]' } }, stream);

  return { logger, getOutput: () => chunks.join('') };
}

describe('log redaction (REDACTED_PATHS)', () => {
  it('redacts the Authorization header nested under req.headers - the specific, verified leak', () => {
    const { logger, getOutput } = createCapturingLogger();
    const realToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-real-token';

    logger.info({ req: { headers: { authorization: `Bearer ${realToken}` } } }, 'request completed');

    const output = getOutput();
    expect(output).not.toContain(realToken);
    expect(output).toContain('[Redacted]');
  });

  it('redacts a password field wherever it appears, not just at one hardcoded path', () => {
    const { logger, getOutput } = createCapturingLogger();

    logger.info({ user: { email: 'test@example.com', password: 'plaintext-password-123' } }, 'user data');

    const output = getOutput();
    expect(output).not.toContain('plaintext-password-123');
    expect(output).toContain('[Redacted]');
    // Unrelated field on the same object must survive - over-redaction
    // is its own production problem (destroyed debuggability).
    expect(output).toContain('test@example.com');
  });

  it('redacts accessToken and refreshToken wherever they appear', () => {
    const { logger, getOutput } = createCapturingLogger();

    logger.info(
      { tokens: { accessToken: 'access-token-abc', refreshToken: 'refresh-token-xyz' } },
      'issued tokens',
    );

    const output = getOutput();
    expect(output).not.toContain('access-token-abc');
    expect(output).not.toContain('refresh-token-xyz');
  });

  it('redacts a cookie header the same way as the authorization header', () => {
    const { logger, getOutput } = createCapturingLogger();

    logger.info({ req: { headers: { cookie: 'session=real-session-id-value' } } }, 'request completed');

    const output = getOutput();
    expect(output).not.toContain('real-session-id-value');
  });

  it('does not redact unrelated fields, and does not throw on log calls with no sensitive paths at all', () => {
    const { logger, getOutput } = createCapturingLogger();

    logger.info({ repositoryId: 'repo-123', fileCount: 40 }, 'File walk complete');

    const output = getOutput();
    expect(output).toContain('repo-123');
    expect(output).toContain('File walk complete');
    expect(output).not.toContain('[Redacted]');
  });
});
