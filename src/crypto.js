/**
 * FREENET-BLOB: Cryptography & Hashing Utilities
 * Cross-platform (Browser & Node.js).
 */

import { blake3 } from '@noble/hashes/blake3.js';

export function hashBlake3(bytes) {
  return blake3(bytes);
}

export function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function toB64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function fromB64(b64) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function getSubtleCrypto() {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    return globalThis.crypto.subtle;
  }
  throw new Error('WebCrypto subtle is not available in this environment');
}

/**
 * Derives an AES-GCM CryptoKey from a secret passphrase/seed using PBKDF2.
 */
export async function deriveKey(secret, salt) {
  const subtle = getSubtleCrypto();
  const enc = new TextEncoder();
  const rawKey = typeof secret === 'string' ? enc.encode(secret) : secret;

  const keyMaterial = await subtle.importKey(
    'raw',
    rawKey,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Derives deterministic 12-byte IV for shard index.
 */
export function makeShardIv(baseIv, shardIndex) {
  const iv = new Uint8Array(12);
  iv.set(baseIv.subarray(0, 8), 0);
  const view = new DataView(iv.buffer, 8, 4);
  view.setUint32(0, shardIndex, false);
  return iv;
}

