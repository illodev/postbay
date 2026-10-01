import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 1;

/**
 * Seals the tokens that let the app publish for a brand. AES-256-GCM with a master key that never lives in the database
 * (an environment variable here; a KMS would plug in at this seam). Each value is bound to what it belongs to
 * (`aad`, such as the account id), so a sealed token copied onto another row fails to open.
 *
 * Layout: 1 byte version | 12 bytes IV | 16 bytes auth tag | ciphertext.
 */
export class TokenVault {
  private key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('TOKEN_KEY must decode to exactly 32 bytes');
    this.key = key;
  }

  /** Reads the key from a base64 string (`openssl rand -base64 32`). */
  static fromBase64(value: string): TokenVault {
    return new TokenVault(Buffer.from(value, 'base64'));
  }

  seal(value: unknown, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  open<T>(sealed: Buffer, aad: string): T {
    if (sealed.length < 30 || sealed[0] !== VERSION) throw new Error('Unreadable sealed value');
    const iv = sealed.subarray(1, 13);
    const tag = sealed.subarray(13, 29);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
