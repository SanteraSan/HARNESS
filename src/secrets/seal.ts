import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

import { SecretError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const TAG_BYTES = 16;

export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  salt: Buffer;
}

/**
 * Ключ из окружения в SQL не уходит: производный ключ живёт в процессе
 * и затирается сразу после шифра. В базе остаётся только шифртекст.
 */
export async function seal(plaintext: string, passphrase: string): Promise<SealedSecret> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([body, tag]),
      nonce,
      salt,
    };
  } finally {
    key.fill(0);
  }
}

/** Чужой ключ и битый шифртекст дают один и тот же отказ, без текста секрета. */
export async function openSealed(sealed: SealedSecret, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, sealed.salt);
  try {
    if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length <= TAG_BYTES) {
      throw new SecretError("decrypt_failed", "connector secret could not be opened");
    }
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return plain.toString("utf8");
  } catch (error) {
    if (error instanceof SecretError) {
      throw error;
    }
    throw new SecretError("decrypt_failed", "connector secret could not be opened");
  } finally {
    key.fill(0);
  }
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEY_BYTES, (error, derived) => {
      if (error !== null) {
        reject(new SecretError("key_derivation", "connector encryption key was not derived"));
        return;
      }
      resolve(derived);
    });
  });
}
