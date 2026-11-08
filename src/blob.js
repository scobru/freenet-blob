/**
 * FREENET-BLOB: High-Level Resilient Blob API
 * Provides upload, download, inspection, and auto-healing (repair) for Freenet.
 */

import { encodeFEC, decodeFEC, regenerateShard } from './fec.js';
import {
  deriveKey,
  getSubtleCrypto,
  makeShardIv,
  toB64,
  fromB64,
} from './crypto.js';
import { putChunk, getChunk } from './freenet.js';

export const DEFAULT_SHARD_SIZE = 256 * 1024; // 256 KB per Freenet chunk contract

/**
 * Uploads a file/buffer to Freenet with Reed-Solomon Forward Error Correction (FEC).
 *
 * @param {Object} params
 * @param {Uint8Array|ArrayBuffer|Blob} params.data - The data to store
 * @param {string} [params.filename='file.bin'] - Filename
 * @param {string} [params.mimeType='application/octet-stream'] - MIME type
 * @param {boolean} [params.encrypt=false] - Whether to encrypt shards with AES-GCM
 * @param {string|Uint8Array} [params.key] - Encryption key or secret (required if encrypt=true)
 * @param {number} [params.shardSize=262144] - Shard size in bytes (default: 256KB)
 * @param {number} [params.parityRatio=0.33] - Parity ratio (default: ~33% redundancy)
 * @param {Function} [params.onProgress] - Progress callback: ({ progress, loaded, total, shardIndex, totalShards })
 * @param {Function} [params.onStatusChange] - Status message callback: (statusObj)
 * @param {Object} [params.freenetOptions] - Freenet node options (wsUrl, timeoutMs)
 * @returns {Promise<Object>} The standard BlobManifest
 */
export async function uploadBlob({
  data,
  filename = 'file.bin',
  mimeType = 'application/octet-stream',
  encrypt = false,
  key = null,
  shardSize = DEFAULT_SHARD_SIZE,
  parityRatio = 0.33,
  onProgress = () => {},
  onStatusChange = () => {},
  freenetOptions = {},
}) {
  let fileBytes;
  if (data instanceof Uint8Array) {
    fileBytes = data;
  } else if (data instanceof ArrayBuffer) {
    fileBytes = new Uint8Array(data);
  } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    fileBytes = new Uint8Array(await data.arrayBuffer());
  } else {
    throw new Error('Unsupported data format: expected Uint8Array, ArrayBuffer, or Blob');
  }

  const fileSize = fileBytes.byteLength;

  // 1. Calculate Reed-Solomon FEC Shards
  const fecResult = encodeFEC(fileBytes, { shardSize, redundancyRatio: parityRatio });
  const { k, m, totalShards, shards } = fecResult;

  onStatusChange({
    status: 'encoding',
    message: `Encoded with FEC into ${totalShards} shards (${k} data + ${m} parity)`,
    k,
    m,
    totalShards,
  });

  // 2. Setup Optional Encryption
  let aesKey = null;
  let salt = null;
  let baseIv = null;

  if (encrypt) {
    if (!key) throw new Error('Encryption requested but no key provided');
    salt = crypto.getRandomValues(new Uint8Array(16));
    baseIv = crypto.getRandomValues(new Uint8Array(12));
    aesKey = await deriveKey(key, salt);
  }

  const subtle = encrypt ? getSubtleCrypto() : null;

  // 3. Upload Shards to Freenet
  const chunkAddresses = [];
  for (let i = 0; i < totalShards; i++) {
    const shard = shards[i];
    let payload = shard.data;

    if (encrypt) {
      const shardIv = makeShardIv(baseIv, i);
      payload = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv: shardIv }, aesKey, shard.data)
      );
    }

    const addr = await putChunk(payload, freenetOptions);
    chunkAddresses.push(addr);

    const percent = Math.round(((i + 1) / totalShards) * 100);
    const label = shard.isParity ? `Parity ${i - k + 1}/${m}` : `Data ${i + 1}/${k}`;

    onProgress({
      progress: percent,
      loaded: Math.min((i + 1) * fecResult.shardSize, fileSize),
      total: fileSize,
      shardIndex: i + 1,
      totalShards,
    });

    onStatusChange({
      status: 'uploading',
      message: `Uploaded shard ${i + 1}/${totalShards} [${label}] to Freenet (${percent}%)`,
      percent,
    });
  }

  // 4. Return BlobManifest
  const manifest = {
    v: 1,
    generator: 'freenet-blob',
    filename,
    mimeType,
    size: fileSize,
    createdAt: Date.now(),
    encrypted: Boolean(encrypt),
    fec: {
      enabled: true,
      k,
      m,
      total: totalShards,
      originalSize: fileSize,
      shardSize: fecResult.shardSize,
    },
    chunks: chunkAddresses,
    crypto: encrypt
      ? {
          salt: toB64(salt),
          iv: toB64(baseIv),
          algorithm: 'AES-GCM',
        }
      : null,
  };

  onStatusChange({
    status: 'completed',
    message: 'Blob successfully uploaded and distributed on Freenet with FEC redundancy!',
    manifest,
  });

  return manifest;
}

/**
 * Downloads and reconstructs a blob from Freenet using its manifest.
 * Automatically handles missing shards via Reed-Solomon reconstruction.
 *
 * @param {Object} params
 * @param {Object} params.manifest - The BlobManifest
 * @param {string|Uint8Array} [params.key] - Decryption key (if encrypted)
 * @param {Function} [params.onProgress] - Progress callback
 * @param {Function} [params.onStatusChange] - Status message callback
 * @param {Object} [params.freenetOptions] - Freenet node options
 * @returns {Promise<{ data: Uint8Array, filename: string, mimeType: string, size: number }>}
 */
export async function downloadBlob({
  manifest,
  key = null,
  onProgress = () => {},
  onStatusChange = () => {},
  freenetOptions = {},
}) {
  if (!manifest || !manifest.chunks || !Array.isArray(manifest.chunks)) {
    throw new Error('Invalid manifest provided to downloadBlob');
  }

  const { filename, mimeType, size, fec, chunks, encrypted, crypto: cryptoMeta } = manifest;
  const isFec = Boolean(fec && fec.enabled);
  const targetK = isFec ? fec.k : chunks.length;
  const totalChunks = chunks.length;

  let aesKey = null;
  let baseIv = null;
  if (encrypted) {
    if (!key) throw new Error('Blob is encrypted but no decryption key was supplied');
    if (!cryptoMeta || !cryptoMeta.salt || !cryptoMeta.iv) {
      throw new Error('Missing encryption metadata in manifest');
    }
    const salt = fromB64(cryptoMeta.salt);
    baseIv = fromB64(cryptoMeta.iv);
    aesKey = await deriveKey(key, salt);
  }

  const subtle = encrypted ? getSubtleCrypto() : null;

  onStatusChange({
    status: 'downloading',
    message: isFec
      ? `Fetching shards from Freenet (need any ${targetK} of ${totalChunks} resilient shards)...`
      : `Fetching ${totalChunks} chunks...`,
  });

  const receivedShards = [];

  for (let i = 0; i < totalChunks; i++) {
    const addr = chunks[i];

    try {
      const rawChunk = await getChunk(addr, freenetOptions);
      let shardData = rawChunk;

      if (encrypted) {
        const shardIv = makeShardIv(baseIv, i);
        shardData = new Uint8Array(
          await subtle.decrypt({ name: 'AES-GCM', iv: shardIv }, aesKey, rawChunk)
        );
      }

      receivedShards.push({ index: i, data: shardData });

      const percent = Math.min(100, Math.round((receivedShards.length / targetK) * 100));
      onProgress({
        progress: percent,
        loaded: Math.min(receivedShards.length * (fec?.shardSize || DEFAULT_SHARD_SIZE), size),
        total: size,
        retrievedCount: receivedShards.length,
        requiredCount: targetK,
      });

      onStatusChange({
        status: 'retrieving',
        message: `Retrieved shard ${receivedShards.length}/${targetK} required (${percent}%)`,
      });

      // Break as soon as K shards are reached
      if (isFec && receivedShards.length >= targetK) {
        break;
      }
    } catch (err) {
      onStatusChange({
        status: 'shard_miss',
        message: `Shard #${i} unreachable (${err.message}). Parity will compensate.`,
        shardIndex: i,
      });
    }
  }

  if (receivedShards.length < targetK) {
    throw new Error(
      `Failed to reconstruct blob: only ${receivedShards.length}/${targetK} shards available on Freenet`
    );
  }

  let restoredBytes;
  if (isFec) {
    restoredBytes = decodeFEC(receivedShards, fec);
  } else {
    restoredBytes = new Uint8Array(size);
    let offset = 0;
    for (let i = 0; i < totalChunks; i++) {
      const s = receivedShards.find((sh) => sh.index === i);
      if (!s) throw new Error(`Missing chunk #${i}`);
      restoredBytes.set(s.data, offset);
      offset += s.data.byteLength;
    }
  }

  onStatusChange({
    status: 'completed',
    message: 'Blob successfully downloaded and reconstructed with 100% data integrity!',
  });

  return {
    data: restoredBytes,
    filename,
    mimeType,
    size,
  };
}

/**
 * Inspects the health of a distributed blob on Freenet.
 *
 * @param {Object} params
 * @param {Object} params.manifest
 * @param {Object} [params.freenetOptions]
 * @returns {Promise<{ totalShards: number, requiredShards: number, availableShards: number, missingShards: number[], health: number, isRecoverable: boolean, needsRepair: boolean }>}
 */
export async function inspectBlob({ manifest, freenetOptions = {} }) {
  const { chunks, fec } = manifest;
  const isFec = Boolean(fec && fec.enabled);
  const targetK = isFec ? fec.k : chunks.length;
  const total = chunks.length;

  const missingShards = [];
  let availableCount = 0;

  for (let i = 0; i < total; i++) {
    try {
      await getChunk(chunks[i], freenetOptions);
      availableCount++;
    } catch (_) {
      missingShards.push(i);
    }
  }

  const health = Math.round((availableCount / total) * 100);
  const isRecoverable = availableCount >= targetK;
  const needsRepair = missingShards.length > 0 && isRecoverable;

  return {
    totalShards: total,
    requiredShards: targetK,
    availableShards: availableCount,
    missingShards,
    health,
    isRecoverable,
    needsRepair,
  };
}

/**
 * Auto-healing (Chunk Regeneration):
 * Probes the blob, regenerates any missing data or parity shards,
 * and re-publishes them to Freenet to keep the file alive indefinitely.
 *
 * @param {Object} params
 * @param {Object} params.manifest
 * @param {string|Uint8Array} [params.key]
 * @param {Function} [params.onStatusChange]
 * @param {Object} [params.freenetOptions]
 * @returns {Promise<{ status: string, healedCount: number, missingCount: number }>}
 */
export async function repairBlob({
  manifest,
  key = null,
  onStatusChange = () => {},
  freenetOptions = {},
}) {
  const { fec, chunks, encrypted, crypto: cryptoMeta } = manifest;
  if (!fec || !fec.enabled) {
    throw new Error('Cannot repair a blob that was not created with FEC redundancy');
  }

  const targetK = fec.k;
  const total = chunks.length;

  let aesKey = null;
  let baseIv = null;
  if (encrypted) {
    if (!key) throw new Error('Decryption key required to repair encrypted blob');
    const salt = fromB64(cryptoMeta.salt);
    baseIv = fromB64(cryptoMeta.iv);
    aesKey = await deriveKey(key, salt);
  }
  const subtle = encrypted ? getSubtleCrypto() : null;

  onStatusChange({
    status: 'inspecting',
    message: 'Auditing shards across Freenet network...',
  });

  const availableShards = [];
  const missingIndices = [];

  for (let i = 0; i < total; i++) {
    try {
      const rawChunk = await getChunk(chunks[i], freenetOptions);
      let shardData = rawChunk;
      if (encrypted) {
        const shardIv = makeShardIv(baseIv, i);
        shardData = new Uint8Array(
          await subtle.decrypt({ name: 'AES-GCM', iv: shardIv }, aesKey, rawChunk)
        );
      }
      availableShards.push({ index: i, data: shardData });
    } catch (_) {
      missingIndices.push(i);
    }
  }

  if (missingIndices.length === 0) {
    onStatusChange({
      status: 'healthy',
      message: 'All shards are 100% available on Freenet. No repair needed.',
    });
    return { status: 'healthy', healedCount: 0, missingCount: 0 };
  }

  if (availableShards.length < targetK) {
    throw new Error(
      `Cannot heal blob: too many shards lost (${availableShards.length}/${targetK} available)`
    );
  }

  onStatusChange({
    status: 'healing',
    message: `Regenerating and restoring ${missingIndices.length} missing shards...`,
  });

  let healedCount = 0;
  for (const missingIndex of missingIndices) {
    const healedPlain = regenerateShard(availableShards, missingIndex, fec);
    let payload = healedPlain;

    if (encrypted) {
      const shardIv = makeShardIv(baseIv, missingIndex);
      payload = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv: shardIv }, aesKey, healedPlain)
      );
    }

    await putChunk(payload, freenetOptions);
    healedCount++;

    onStatusChange({
      status: 'healed_shard',
      message: `Republished healed shard #${missingIndex} to Freenet (${healedCount}/${missingIndices.length})`,
      healedCount,
    });
  }

  onStatusChange({
    status: 'fully_healed',
    message: `Self-healing complete: ${healedCount} shards regenerated and published!`,
  });

  return { status: 'fully_healed', healedCount, missingCount: missingIndices.length };
}

