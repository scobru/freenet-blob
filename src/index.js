/**
 * FREENET-BLOB
 * Standard Fault-Tolerant Decentralized Storage with Reed-Solomon Erasure Coding (FEC)
 * and Auto-Healing for Freenet.
 */

export {
  uploadBlob,
  downloadBlob,
  inspectBlob,
  repairBlob,
  DEFAULT_SHARD_SIZE,
} from './blob.js';

export {
  encodeFEC,
  decodeFEC,
  regenerateShard,
  calculateParityCount,
  createGeneratorMatrix,
} from './fec.js';

export {
  putChunk,
  getChunk,
  getChunkWasm,
  getChunkContractKey,
  isFreenetAvailable,
  getFreenetWsUrl,
} from './freenet.js';

export {
  hashBlake3,
  deriveKey,
  getSubtleCrypto,
  makeShardIv,
  toHex,
  fromHex,
  toB64,
  fromB64,
} from './crypto.js';
