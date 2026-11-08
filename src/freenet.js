/**
 * FREENET-BLOB: Freenet WebSocket Client & Chunk Contract Handler
 * Supports both Node.js (fdev or direct WS) and Browser (in-app or localhost gateway).
 */

import {
  ContractContainer,
  ContractKey,
  ContractType,
  FreenetWsApi,
  GetRequest,
  PutRequest,
  WasmContractV1,
} from '@freenetorg/freenet-stdlib';
import { ContractCodeT } from '@freenetorg/freenet-stdlib/common';
import { hashBlake3, toHex } from './crypto.js';

const isNode =
  typeof process !== 'undefined' &&
  Boolean(process.versions?.node) &&
  typeof window === 'undefined';

let cachedChunkWasm = null;

/**
 * Loads the standard chunk.wasm contract bytecode and computes its BLAKE3 hash.
 */
export async function getChunkWasm(customWasmPath = null) {
  if (cachedChunkWasm) return cachedChunkWasm;

  let code;
  if (isNode) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const defaultPaths = [
      customWasmPath,
      path.join(here, '../contracts/chunk.wasm'),
      path.join(process.cwd(), 'contracts/chunk.wasm'),
    ].filter(Boolean);

    const found = defaultPaths.find((p) => fs.existsSync(p));
    if (!found) {
      throw new Error('chunk.wasm contract not found in filesystem');
    }
    code = new Uint8Array(fs.readFileSync(found));
  } else {
    // Browser environment: fetch from relative contracts path or root
    const candidates = [
      customWasmPath,
      './contracts/chunk.wasm',
      '/contracts/chunk.wasm',
      'contracts/chunk.wasm',
    ].filter(Boolean);

    let res;
    for (const p of candidates) {
      try {
        res = await fetch(p);
        if (res.ok) break;
      } catch (_) {}
    }
    if (!res || !res.ok) {
      throw new Error('Failed to fetch chunk.wasm in browser environment');
    }
    code = new Uint8Array(await res.arrayBuffer());
  }

  const codeHash = hashBlake3(code);
  cachedChunkWasm = { code, codeHash };
  return cachedChunkWasm;
}

/**
 * Builds the ContractKey for a content-addressed chunk.
 * Parameter = BLAKE3(chunk_bytes).
 */
export async function getChunkContractKey(chunkBytes, customWasmPath = null) {
  const { codeHash } = await getChunkWasm(customWasmPath);
  const params = hashBlake3(chunkBytes);
  return ContractKey.fromParams(codeHash, params);
}

/**
 * Resolves the WebSocket URL for Freenet.
 */
export function getFreenetWsUrl(customUrl = null) {
  if (customUrl) return new URL(customUrl);
  const loc = typeof globalThis.location !== 'undefined' ? globalThis.location : null;
  if (!loc) return new URL('ws://127.0.0.1:7509/v1/contract/command');
  const isFreenetGateway =
    loc.port === '7509' || (loc.pathname && loc.pathname.includes('/v1/contract/'));
  const host = isFreenetGateway ? loc.host || '127.0.0.1:7509' : '127.0.0.1:7509';
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return new URL(`${proto}://${host}/v1/contract/command`);
}

/**
 * Checks if the local Freenet node is active and reachable.
 */
export async function isFreenetAvailable(timeoutMs = 1200, customUrl = null) {
  return new Promise((resolve) => {
    let settled = false;
    const wsUrl = getFreenetWsUrl(customUrl);

    try {
      const WebSocketCtor =
        typeof WebSocket !== 'undefined'
          ? WebSocket
          : globalThis.WebSocket;

      if (!WebSocketCtor) {
        resolve(false);
        return;
      }

      const socket = new WebSocketCtor(wsUrl.toString());
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            socket.close();
          } catch (_) {}
          resolve(false);
        }
      }, timeoutMs);

      socket.onopen = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            socket.close();
          } catch (_) {}
          resolve(true);
        }
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      };
    } catch (_) {
      resolve(false);
    }
  });
}

/**
 * Puts a single chunk contract onto the Freenet network.
 * @param {Uint8Array} chunkBytes
 * @param {Object} [options]
 * @returns {Promise<string>} The contract address encoded as hex/base58
 */
export async function putChunk(chunkBytes, options = {}) {
  const { wsUrl = null, timeoutMs = 15000, wasmPath = null } = options;
  const { code, codeHash } = await getChunkWasm(wasmPath);
  const params = hashBlake3(chunkBytes);

  const contractKey = ContractKey.fromParams(codeHash, params);
  const container = ContractContainer.from(
    new ContractType(
      ContractCodeT.WasmContractV1,
      new WasmContractV1(code, params)
    )
  );

  const api = await FreenetWsApi.connect(getFreenetWsUrl(wsUrl));

  try {
    const putReq = new PutRequest(container, chunkBytes, false);
    const putPromise = api.put(putReq);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Freenet putChunk timeout')), timeoutMs)
    );

    await Promise.race([putPromise, timeoutPromise]);
    return contractKey.encode();
  } finally {
    try {
      api.disconnect();
    } catch (_) {}
  }
}

/**
 * Gets a single chunk contract from the Freenet network.
 * @param {string|ContractKey} keyOrAddress
 * @param {Object} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function getChunk(keyOrAddress, options = {}) {
  const { wsUrl = null, timeoutMs = 20000 } = options;
  const contractKey =
    typeof keyOrAddress === 'string'
      ? ContractKey.decode(keyOrAddress)
      : keyOrAddress;

  const api = await FreenetWsApi.connect(getFreenetWsUrl(wsUrl));

  try {
    const getReq = new GetRequest(contractKey, false);
    const getPromise = api.get(getReq);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Freenet getChunk timeout')), timeoutMs)
    );

    const res = await Promise.race([getPromise, timeoutPromise]);
    if (!res || !res.state) {
      throw new Error('Empty chunk state returned from Freenet');
    }

    return new Uint8Array(res.state);
  } finally {
    try {
      api.disconnect();
    } catch (_) {}
  }
}

