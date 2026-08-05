import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // GCM's recommended IV length

export interface EncryptedValue {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyVersion: number;
}

/**
 * Generic infrastructure for reversibly encrypting a sensitive string -
 * deliberately not GitHub- or OAuth-specific. A GitHub OAuth token today,
 * or any future third-party credential this app needs to store and later
 * use in plaintext, has the identical actual requirement: encrypt now,
 * decrypt on demand, detect tampering. Coupling this interface to one
 * caller's business context (e.g. a `githubToken` field name) would
 * couple a pure cryptographic primitive to a single use case that
 * happens to be first in line, not the reason this exists.
 */
export interface ITokenEncryptor {
  encrypt(plaintext: string): EncryptedValue;
  decrypt(value: EncryptedValue): string;
}

/**
 * Why AES-256-GCM specifically?
 *
 * Authenticated encryption - unlike a plain cipher mode, GCM detects
 * tampering (a modified ciphertext or a wrong key both fail loudly via
 * the auth tag check, verified directly against Node's real crypto
 * module before this class was written, not assumed from documentation)
 * rather than silently producing garbage plaintext. It's built into
 * Node's standard library - no new dependency for something this
 * security-sensitive.
 *
 * Why is a fresh IV generated on every encrypt() call, and why does that
 * matter enough to document?
 *
 * AES-GCM requires a unique IV per encryption under a given key - this
 * isn't a minor detail. Reusing an IV with the same key doesn't just
 * weaken the encryption, it can leak the authentication key entirely.
 * crypto.randomBytes(12) generates a fresh one every single call; the IV
 * itself isn't secret, it just has to be unique and available at
 * decryption time, which is why it's returned alongside the ciphertext
 * rather than kept internal.
 *
 * Why does decrypt() check keyVersion before attempting anything,
 * instead of just trying to decrypt and letting it fail?
 *
 * This service intentionally does NOT implement multi-key rotation
 * (decrypt-with-any-known-version) - with exactly one key in existence
 * today, that would be solving a problem that doesn't exist yet. But
 * every EncryptedValue carries the key version it was encrypted with,
 * so a FUTURE rotation is an additive change (add a new key, bump the
 * current version, old records still readable by a rotation-aware
 * decrypt) rather than a breaking migration. Checking the version
 * explicitly, with a clear error naming the mismatch, is what makes a
 * future version-mismatch bug diagnosable in one line instead of a
 * cryptic GCM authentication failure that could just as easily mean
 * "tampered" as "wrong key version."
 */
export class TokenEncryptor implements ITokenEncryptor {
  private readonly key: Buffer;

  constructor(
    base64Key: string,
    private readonly keyVersion: number,
  ) {
    const decoded = Buffer.from(base64Key, 'base64');
    if (decoded.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        `TokenEncryptor key must decode to exactly ${KEY_LENGTH_BYTES} bytes for AES-256 ` +
          `(got ${decoded.length}). Generate one with: openssl rand -base64 32`,
      );
    }
    this.key = decoded;
  }

  encrypt(plaintext: string): EncryptedValue {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(value: EncryptedValue): string {
    if (value.keyVersion !== this.keyVersion) {
      throw new Error(
        `No key configured for version ${value.keyVersion} (this service is configured with version ${this.keyVersion})`,
      );
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  }
}
