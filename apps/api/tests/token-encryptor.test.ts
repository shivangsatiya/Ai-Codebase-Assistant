import { randomBytes } from 'crypto';
import { TokenEncryptor } from '../src/utils/token-encryptor';

function generateValidKey(): string {
  return randomBytes(32).toString('base64');
}

describe('TokenEncryptor - construction', () => {
  it('constructs successfully with a valid 32-byte base64 key', () => {
    expect(() => new TokenEncryptor(generateValidKey(), 1)).not.toThrow();
  });

  it('throws a clear, actionable error for a key that is too short', () => {
    const tooShort = randomBytes(16).toString('base64'); // 16 bytes, not 32

    expect(() => new TokenEncryptor(tooShort, 1)).toThrow(/must decode to exactly 32 bytes/);
  });

  it('throws a clear, actionable error for a key that is too long', () => {
    const tooLong = randomBytes(64).toString('base64');

    expect(() => new TokenEncryptor(tooLong, 1)).toThrow(/must decode to exactly 32 bytes/);
  });

  it('the error message includes the actual byte count received, for debuggability', () => {
    const tooShort = randomBytes(16).toString('base64');

    expect(() => new TokenEncryptor(tooShort, 1)).toThrow(/got 16/);
  });
});

describe('TokenEncryptor - round trip', () => {
  it('decrypts to exactly the original plaintext', () => {
    const encryptor = new TokenEncryptor(generateValidKey(), 1);
    const plaintext = 'ghp_realisticLookingGitHubTokenValue1234567890';

    const encrypted = encryptor.encrypt(plaintext);
    const decrypted = encryptor.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('round-trips correctly for an empty string', () => {
    const encryptor = new TokenEncryptor(generateValidKey(), 1);

    const encrypted = encryptor.encrypt('');
    expect(encryptor.decrypt(encrypted)).toBe('');
  });

  it('round-trips correctly for unicode content', () => {
    const encryptor = new TokenEncryptor(generateValidKey(), 1);
    const plaintext = '🔐 secret-with-emoji-and-ünïcödé-日本語';

    const encrypted = encryptor.encrypt(plaintext);
    expect(encryptor.decrypt(encrypted)).toBe(plaintext);
  });

  it('round-trips correctly for a long value', () => {
    const encryptor = new TokenEncryptor(generateValidKey(), 1);
    const plaintext = 'x'.repeat(10_000);

    const encrypted = encryptor.encrypt(plaintext);
    expect(encryptor.decrypt(encrypted)).toBe(plaintext);
  });

  it('stamps the EncryptedValue with the configured key version', () => {
    const encryptor = new TokenEncryptor(generateValidKey(), 3);

    const encrypted = encryptor.encrypt('a secret');

    expect(encrypted.keyVersion).toBe(3);
  });
});

describe('TokenEncryptor - IV uniqueness', () => {
  it('generates a different IV and ciphertext on every call, even for identical plaintext', () => {
    // This is the specific property that makes AES-GCM safe: reusing an
    // IV under the same key for two different encryptions doesn't just
    // weaken the encryption, it can leak the authentication key
    // entirely. This test would fail if IV generation were ever
    // accidentally made deterministic or cached.
    const encryptor = new TokenEncryptor(generateValidKey(), 1);
    const plaintext = 'the same secret value';

    const first = encryptor.encrypt(plaintext);
    const second = encryptor.encrypt(plaintext);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);

    // Both must still independently decrypt correctly despite differing.
    expect(encryptor.decrypt(first)).toBe(plaintext);
    expect(encryptor.decrypt(second)).toBe(plaintext);
  });
});

describe('TokenEncryptor - tamper detection', () => {
  it('throws when the ciphertext has been modified', () => {
    const encryptor = new TokenEncryptor(generateValidKey(), 1);
    const encrypted = encryptor.encrypt('a secret value');

    const tamperedBuffer = Buffer.from(encrypted.ciphertext, 'base64');
    tamperedBuffer[0] = tamperedBuffer[0]! ^ 0xff; // flip a bit
    const tampered = { ...encrypted, ciphertext: tamperedBuffer.toString('base64') };

    expect(() => encryptor.decrypt(tampered)).toThrow();
  });

  it('throws when the auth tag has been modified', () => {
    const encryptor = new TokenEncryptor(generateValidKey(), 1);
    const encrypted = encryptor.encrypt('a secret value');

    const tamperedBuffer = Buffer.from(encrypted.authTag, 'base64');
    tamperedBuffer[0] = tamperedBuffer[0]! ^ 0xff;
    const tampered = { ...encrypted, authTag: tamperedBuffer.toString('base64') };

    expect(() => encryptor.decrypt(tampered)).toThrow();
  });

  it('throws when decrypted with the wrong key entirely', () => {
    const encryptorA = new TokenEncryptor(generateValidKey(), 1);
    const encryptorB = new TokenEncryptor(generateValidKey(), 1); // different key, same version

    const encrypted = encryptorA.encrypt('a secret value');

    expect(() => encryptorB.decrypt(encrypted)).toThrow();
  });
});

describe('TokenEncryptor - key versioning', () => {
  it('throws a specific, actionable error on a key version mismatch, not a generic crypto failure', () => {
    const encryptorV1 = new TokenEncryptor(generateValidKey(), 1);
    const encryptorV2 = new TokenEncryptor(generateValidKey(), 2);

    const encryptedWithV1 = encryptorV1.encrypt('a secret value');

    // Deliberately checking the error MESSAGE, not just that it throws -
    // the whole point of this check (see the class's own doc comment)
    // is that a future version-mismatch bug should be diagnosable in
    // one line, not indistinguishable from "tampered ciphertext."
    expect(() => encryptorV2.decrypt(encryptedWithV1)).toThrow(/No key configured for version 1/);
  });
});
