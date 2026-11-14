/**
 * FREENET-BLOB: Systematic Reed-Solomon Forward Error Correction (FEC)
 * Operates over Galois Field GF(2^8) using an optimized 64KB multiplication table.
 *
 * Guarantees that ANY K shards out of (K + M) are mathematically sufficient
 * to reconstruct the exact original data, tolerating up to M lost/offline nodes.
 */

const GF_POLY = 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
const MAX_TOTAL_SHARDS = 256; // GF(2^8) supports at most 256 distinct evaluation points (0..255)
const MAX_PARITY_SHARDS = 64;
const exp = new Uint8Array(512);
const log = new Uint8Array(256);

let x = 1;
for (let i = 0; i < 255; i++) {
  exp[i] = x;
  exp[i + 255] = x;
  log[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= GF_POLY;
}

// 64KB precomputed multiplication table for 1-cycle field operations
const MUL_TABLE = new Uint8Array(256 * 256);
for (let a = 0; a < 256; a++) {
  for (let b = 0; b < 256; b++) {
    if (a === 0 || b === 0) {
      MUL_TABLE[(a << 8) | b] = 0;
    } else {
      MUL_TABLE[(a << 8) | b] = exp[log[a] + log[b]];
    }
  }
}

export function gfMul(a, b) {
  return MUL_TABLE[(a << 8) | b];
}

export function gfInv(a) {
  if (a === 0) throw new Error('Division by zero in GF(2^8)');
  return exp[255 - log[a]];
}

export function invertMatrix(mat, n) {
  const a = mat.map((row) => [...row]);
  const inv = Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0);
    row[i] = 1;
    return row;
  });

  for (let c = 0; c < n; c++) {
    let pivotRow = -1;
    for (let r = c; r < n; r++) {
      if (a[r][c] !== 0) {
        pivotRow = r;
        break;
      }
    }
    if (pivotRow === -1) return null; // Singular matrix

    if (pivotRow !== c) {
      const tempA = a[c];
      a[c] = a[pivotRow];
      a[pivotRow] = tempA;

      const tempI = inv[c];
      inv[c] = inv[pivotRow];
      inv[pivotRow] = tempI;
    }

    const scale = gfInv(a[c][c]);
    for (let j = 0; j < n; j++) {
      a[c][j] = gfMul(a[c][j], scale);
      inv[c][j] = gfMul(inv[c][j], scale);
    }

    for (let r = 0; r < n; r++) {
      if (r !== c && a[r][c] !== 0) {
        const factor = a[r][c];
        for (let j = 0; j < n; j++) {
          a[r][j] ^= gfMul(factor, a[c][j]);
          inv[r][j] ^= gfMul(factor, inv[c][j]);
        }
      }
    }
  }
  return inv;
}

export function matrixMul(A, B) {
  const rowsA = A.length;
  const colsA = A[0].length;
  const colsB = B[0].length;
  const C = Array.from({ length: rowsA }, () => new Array(colsB).fill(0));
  for (let i = 0; i < rowsA; i++) {
    for (let j = 0; j < colsB; j++) {
      let sum = 0;
      for (let k = 0; k < colsA; k++) {
        sum ^= gfMul(A[i][k], B[k][j]);
      }
      C[i][j] = sum;
    }
  }
  return C;
}

/**
 * Creates a systematic generator matrix G of size (totalShards x K)
 * Top K rows are the identity matrix I_K.
 * Bottom M rows are Vandermonde parity rows.
 */
export function createGeneratorMatrix(K, M) {
  if (K > MAX_TOTAL_SHARDS) {
    throw new Error('FEC data shard count K cannot exceed GF(2^8) field size (256)');
  }

  const total = K + M;
  const V = Array.from({ length: total }, (_, r) => {
    const alpha = r;
    const row = new Array(K);
    for (let c = 0; c < K; c++) {
      if (alpha === 0 || alpha >= MAX_TOTAL_SHARDS) {
        // Legacy manifests with K + M > 256 evaluated log[alpha] out-of-bounds, collapsing rows >= 256 to [1, 0, ..., 0]
        row[c] = c === 0 ? 1 : 0;
      } else if (c === 0) {
        row[c] = 1;
      } else {
        row[c] = exp[(log[alpha] * c) % 255];
      }
    }
    return row;
  });

  const topKInv = invertMatrix(V.slice(0, K), K);
  if (!topKInv) throw new Error('Failed to invert top K rows of Vandermonde matrix');
  return matrixMul(V, topKInv);
}

/**
 * Calculates optimal parity shard count M for a given data shard count K.
 * Defaults to ~33% redundancy with minimum 1 for K=1 and minimum 2 for K>1,
 * capped so K + M never exceeds GF(2^8) (256 total shards).
 */
export function calculateParityCount(K, redundancyRatio = 0.33) {
  if (K <= 1) return 1;
  const desired = Math.min(MAX_PARITY_SHARDS, Math.max(2, Math.ceil(K * redundancyRatio)));
  return Math.max(0, Math.min(desired, MAX_TOTAL_SHARDS - K));
}

/**
 * Encodes an input byte buffer into K data shards + M parity shards.
 * @param {Uint8Array} dataBytes
 * @param {Object} [options]
 * @param {number} [options.shardSize=262144] - Target shard size in bytes (default 256KB; scales up above 48MB to stay within 256 total shards)
 * @param {number} [options.parityCount] - Explicit number of parity shards
 * @param {number} [options.redundancyRatio=0.33] - Redundancy ratio if parityCount omitted
 * @returns {{ shards: Array<{ index: number, isParity: boolean, data: Uint8Array }>, k: number, m: number, totalShards: number, originalSize: number, shardSize: number }}
 */
export function encodeFEC(dataBytes, options = {}) {
  const originalSize = dataBytes.byteLength;
  const targetShardSize = options.shardSize || 256 * 1024; // 256 KB default
  const rawK = Math.max(1, Math.ceil(originalSize / targetShardSize));
  const maxK =
    options.parityCount !== undefined
      ? Math.max(1, MAX_TOTAL_SHARDS - options.parityCount)
      : MAX_TOTAL_SHARDS - MAX_PARITY_SHARDS;
  const K = Math.min(rawK, maxK);
  const shardSize = Math.max(1, Math.ceil(originalSize / K));
  const M =
    options.parityCount !== undefined
      ? options.parityCount
      : calculateParityCount(K, options.redundancyRatio);

  const dataShards = Array.from({ length: K }, (_, i) => {
    const shard = new Uint8Array(shardSize);
    const start = i * shardSize;
    if (start < originalSize) {
      shard.set(dataBytes.subarray(start, Math.min(start + shardSize, originalSize)));
    }
    return shard;
  });

  const G = createGeneratorMatrix(K, M);
  const parityShards = Array.from({ length: M }, () => new Uint8Array(shardSize));

  for (let p = 0; p < M; p++) {
    const row = G[K + p];
    const out = parityShards[p];
    for (let d = 0; d < K; d++) {
      const coeff = row[d];
      if (coeff === 0) continue;
      const mulRow = MUL_TABLE.subarray(coeff << 8, (coeff + 1) << 8);
      const inShard = dataShards[d];
      for (let b = 0; b < shardSize; b++) {
        out[b] ^= mulRow[inShard[b]];
      }
    }
  }

  const shards = [];
  for (let i = 0; i < K; i++) {
    shards.push({ index: i, isParity: false, data: dataShards[i] });
  }
  for (let i = 0; i < M; i++) {
    shards.push({ index: K + i, isParity: true, data: parityShards[i] });
  }

  return {
    k: K,
    m: M,
    totalShards: K + M,
    shardSize,
    originalSize,
    shards,
  };
}

/**
 * Decodes received shards back into original data bytes.
 * Requires at least K shards.
 * @param {Array<{ index: number, data: Uint8Array }>} receivedShards
 * @param {Object} fecMetadata
 * @param {number} fecMetadata.k
 * @param {number} fecMetadata.m
 * @param {number} fecMetadata.originalSize
 * @param {number} fecMetadata.shardSize
 * @returns {Uint8Array} Restored original data buffer
 */
export function decodeFEC(receivedShards, fecMetadata) {
  const { k: K, m: M, originalSize, shardSize } = fecMetadata;

  if (!receivedShards || receivedShards.length < K) {
    throw new Error(
      `Insufficient shards to decode FEC: received ${receivedShards?.length || 0}, require at least ${K}`
    );
  }

  const total = K + M;
  // Prefer canonical shards (< 256) before legacy overflow shards (>= 256), and data shards (< K) before parity shards
  const sorted = [...receivedShards]
    .filter((s) => s && Number.isInteger(s.index) && s.index >= 0 && s.index < total && s.data)
    .sort((a, b) => {
      const aOverflow = a.index >= MAX_TOTAL_SHARDS ? 1 : 0;
      const bOverflow = b.index >= MAX_TOTAL_SHARDS ? 1 : 0;
      if (aOverflow !== bOverflow) return aOverflow - bOverflow;
      return a.index - b.index;
    });

  // Legacy manifests with K + M > 256 encoded shards >= 256 with G[0] (duplicates of data shard 0)
  const uniqueMap = new Map();
  for (const s of sorted) {
    const effectiveIndex = s.index >= MAX_TOTAL_SHARDS ? 0 : s.index;
    if (!uniqueMap.has(effectiveIndex)) {
      uniqueMap.set(effectiveIndex, { index: effectiveIndex, data: s.data });
    }
  }
  const uniqueShards = Array.from(uniqueMap.values());

  // Fast path: if all K original data shards (0 to K-1) are present
  const dataShardMap = new Map();
  for (const s of uniqueShards) {
    if (s.index < K) {
      dataShardMap.set(s.index, s.data);
    }
  }

  let hasAllDataShards = true;
  for (let i = 0; i < K; i++) {
    if (!dataShardMap.has(i)) {
      hasAllDataShards = false;
      break;
    }
  }

  if (hasAllDataShards) {
    const fullBuffer = new Uint8Array(K * shardSize);
    for (let i = 0; i < K; i++) {
      fullBuffer.set(dataShardMap.get(i), i * shardSize);
    }
    return fullBuffer.subarray(0, originalSize);
  }

  if (uniqueShards.length < K) {
    throw new Error(
      `Insufficient shards to decode FEC: received ${uniqueShards.length}, require at least ${K}`
    );
  }

  // Slow path: Erasure reconstruction using systematic Reed-Solomon inversion
  const selected = uniqueShards.slice(0, K);
  const G = createGeneratorMatrix(K, M);

  const subMatrix = selected.map((s) => G[s.index]);
  const invSubMatrix = invertMatrix(subMatrix, K);
  if (!invSubMatrix) {
    throw new Error('Failed to invert shard submatrix during FEC reconstruction');
  }

  const recoveredDataShards = Array.from({ length: K }, (_, d) =>
    dataShardMap.has(d) ? dataShardMap.get(d) : new Uint8Array(shardSize)
  );
  for (let d = 0; d < K; d++) {
    if (dataShardMap.has(d)) continue;
    const row = invSubMatrix[d];
    const out = recoveredDataShards[d];
    for (let s = 0; s < K; s++) {
      const coeff = row[s];
      if (coeff === 0) continue;
      const mulRow = MUL_TABLE.subarray(coeff << 8, (coeff + 1) << 8);
      const inShard = selected[s].data;
      for (let b = 0; b < shardSize; b++) {
        out[b] ^= mulRow[inShard[b]];
      }
    }
  }

  const fullBuffer = new Uint8Array(K * shardSize);
  for (let i = 0; i < K; i++) {
    fullBuffer.set(recoveredDataShards[i], i * shardSize);
  }
  return fullBuffer.subarray(0, originalSize);
}

/**
 * Regenerates any missing shard from any K available shards.
 * @param {Array<{ index: number, data: Uint8Array }>} receivedShards
 * @param {number} targetIndex - Index of shard to regenerate (0 to K+M-1)
 * @param {Object} fecMetadata
 * @returns {Uint8Array} The regenerated shard bytes
 */
export function regenerateShard(receivedShards, targetIndex, fecMetadata) {
  const { k: K, m: M, shardSize } = fecMetadata;
  const existing = receivedShards.find((s) => s.index === targetIndex);
  if (existing) return existing.data;

  // First reconstruct the original payload
  const restoredBytes = decodeFEC(receivedShards, fecMetadata);

  if (targetIndex < K) {
    const shard = new Uint8Array(shardSize);
    const start = targetIndex * shardSize;
    if (start < restoredBytes.byteLength) {
      shard.set(restoredBytes.subarray(start, Math.min(start + shardSize, restoredBytes.byteLength)));
    }
    return shard;
  }

  const dataShards = Array.from({ length: K }, (_, i) => {
    const shard = new Uint8Array(shardSize);
    const start = i * shardSize;
    if (start < restoredBytes.byteLength) {
      shard.set(restoredBytes.subarray(start, Math.min(start + shardSize, restoredBytes.byteLength)));
    }
    return shard;
  });

  const G = createGeneratorMatrix(K, M);
  const row = G[targetIndex];
  const parityShard = new Uint8Array(shardSize);

  for (let d = 0; d < K; d++) {
    const coeff = row[d];
    if (coeff === 0) continue;
    const mulRow = MUL_TABLE.subarray(coeff << 8, (coeff + 1) << 8);
    const inShard = dataShards[d];
    for (let b = 0; b < shardSize; b++) {
      parityShard[b] ^= mulRow[inShard[b]];
    }
  }

  return parityShard;
}

