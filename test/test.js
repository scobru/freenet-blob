import assert from 'node:assert/strict';
import {
  encodeFEC,
  decodeFEC,
  regenerateShard,
  hashBlake3,
  deriveKey,
  makeShardIv,
  getSubtleCrypto,
} from '../src/index.js';

console.log('🧪 Starting Freenet-Blob Comprehensive Test Suite...\n');

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ FAILED: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`✅ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ FAILED: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 1. FEC Unit Tests
test('FEC: Single-chunk file redundancy (K=1, M=1)', () => {
  const payload = new TextEncoder().encode('Freenet-Blob single block');
  const fec = encodeFEC(payload, { shardSize: 1024, parityCount: 1 });
  assert.equal(fec.k, 1);
  assert.equal(fec.m, 1);
  assert.equal(fec.totalShards, 2);

  // Lose original data shard #0
  const recovered = decodeFEC([fec.shards[1]], fec);
  assert.deepEqual(recovered, payload);
});

test('FEC: Multi-chunk file with 2 lost shards (K=4, M=2)', () => {
  const sample = new Uint8Array(4000);
  for (let i = 0; i < sample.length; i++) sample[i] = (i * 31 + 7) & 0xff;

  const fec = encodeFEC(sample, { shardSize: 1000, parityCount: 2 });
  assert.equal(fec.k, 4);
  assert.equal(fec.m, 2);
  assert.equal(fec.totalShards, 6);

  // Lose shard 0 (data) and shard 5 (parity)
  const surviving = fec.shards.filter((s) => s.index !== 0 && s.index !== 5);
  assert.equal(surviving.length, 4);

  const restored = decodeFEC(surviving, fec);
  assert.deepEqual(restored, sample);
});

test('FEC: Auto-healing chunk regeneration', () => {
  const text = 'Testing self-healing chunk regeneration for FreeTunes and Radica';
  const data = new TextEncoder().encode(text);
  const fec = encodeFEC(data, { shardSize: 16, parityCount: 2 });

  // Lose shard 1 and shard 3
  const surviving = fec.shards.filter((s) => s.index !== 1 && s.index !== 3);

  const healedShard1 = regenerateShard(surviving, 1, fec);
  assert.deepEqual(healedShard1, fec.shards[1].data);

  const healedShard3 = regenerateShard(surviving, 3, fec);
  assert.deepEqual(healedShard3, fec.shards[3].data);
});

// 2. High-Level Blob Simulation: End-to-End Upload, Missing Shards, Download, and Auto-Healing
await asyncTest('E2E Blob: Upload, Node Churn Simulation, Resilient Download & Auto-Healing', async () => {
  const originalData = new TextEncoder().encode(
    'Freenet-Blob: Resilient decentralized storage for Radica, FreeTunes, Orto, and FreeHole! ' +
    'Simulating a 2KB file with multiple chunks and encryption.'
  );

  const subtle = getSubtleCrypto();
  const secretKey = 'sovereign-passphrase-2026';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseIv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveKey(secretKey, salt);

  // 1. Encode with FEC (K=4, M=2)
  const fec = encodeFEC(originalData, { shardSize: 32, parityCount: 2 });
  assert.equal(fec.totalShards, fec.k + 2);

  // Mock Freenet contract store
  const mockFreenetStore = new Map();

  for (let i = 0; i < fec.totalShards; i++) {
    const shardIv = makeShardIv(baseIv, i);
    const encrypted = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv: shardIv }, aesKey, fec.shards[i].data)
    );
    const contractAddr = 'contract-addr-' + i;
    mockFreenetStore.set(contractAddr, encrypted);
  }

  assert.equal(mockFreenetStore.size, fec.totalShards);

  // 2. Simulate Node Churn: Delete 2 chunks from Freenet (Shard #1 and Shard #4 lost!)
  mockFreenetStore.delete('contract-addr-1');
  mockFreenetStore.delete('contract-addr-4');
  assert.equal(mockFreenetStore.size, fec.totalShards - 2);

  // 3. Download & Reconstruct from remaining chunks
  const retrievedShards = [];
  for (let i = 0; i < fec.totalShards; i++) {
    const addr = 'contract-addr-' + i;
    if (mockFreenetStore.has(addr)) {
      const enc = mockFreenetStore.get(addr);
      const shardIv = makeShardIv(baseIv, i);
      const dec = new Uint8Array(
        await subtle.decrypt({ name: 'AES-GCM', iv: shardIv }, aesKey, enc)
      );
      retrievedShards.push({ index: i, data: dec });
      if (retrievedShards.length >= fec.k) break; // Sufficiency reached!
    }
  }

  assert.equal(retrievedShards.length, fec.k);
  const restoredBytes = decodeFEC(retrievedShards, fec);
  assert.deepEqual(restoredBytes, originalData);

  // 4. Auto-Healing: Regenerate missing shard #1 and shard #4 and restore to Freenet store
  const healed1 = regenerateShard(retrievedShards, 1, fec);
  const iv1 = makeShardIv(baseIv, 1);
  const enc1 = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv1 }, aesKey, healed1));
  mockFreenetStore.set('contract-addr-1', enc1);

  const healed4 = regenerateShard(retrievedShards, 4, fec);
  const iv4 = makeShardIv(baseIv, 4);
  const enc4 = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv4 }, aesKey, healed4));
  mockFreenetStore.set('contract-addr-4', enc4);

  // Verify store is back to 100% health
  assert.equal(mockFreenetStore.size, fec.totalShards);
});

console.log(`\n🎉 All ${passedTests}/${totalTests} tests passed successfully!`);
