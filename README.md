# freenet-blob

> Fault-tolerant, self-healing decentralized blob storage with **Reed-Solomon Forward Error Correction (FEC)** for Freenet.

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)]()
[![Freenet](https://img.shields.io/badge/freenet-v0.4.0-blue.svg)](https://freenet.org)
[![Zero-WASM-Hassle](https://img.shields.io/badge/fec-GF(2%5E8)-purple.svg)]()

---

## 🎯 The Problem `freenet-blob` Solves

In Freenet, contracts are optimized for small-to-medium states ($\le 1\text{ MB}$). Large files (audio in **FreeTunes**, media in **Radica**, backups in **Orto**, files in **FreeHole**) must be split into chunks.

Without redundancy, a file split into $N$ linear chunks requires **100% of all chunks** ($N$-of-$N$). If a single chunk is slow or lost due to node churn, the entire file is unrecoverable:
$$\text{Probability of success} = (\text{single chunk reliability})^N$$

`freenet-blob` solves this by introducing systematic **Reed-Solomon Erasure Coding ($K$-of-$N$)**:
- A file is broken into $K$ data shards.
- $M$ parity shards are generated using an ultra-fast Galois Field $\text{GF}(2^8)$ matrix engine (~33% redundancy).
- **Any $K$ shards out of $(K + M)$ are mathematically sufficient to reconstruct the entire file bit-for-bit.**
- **Self-Healing**: If nodes drop shards, any client or node can detect missing shards and use `repairBlob()` to regenerate and re-publish them in the background!

```
                                  +---------------+
                                  | Original File |
                                  +-------+-------+
                                          |
                      +-------------------+-------------------+
                      |                                       |
             [ K Data Shards ]                       [ M Parity Shards ]
         (Shard 0, 1, 2 ... K-1)                  (Parity K, K+1 ... K+M-1)
                      |                                       |
                      +-------------------+-------------------+
                                          |
                              [ Immutable Freenet Chunks ]
                             blake3(chunk) Contract Keys
                                          |
                +-------------------------+-------------------------+
                | Any K shards arrive (e.g. 2 nodes offline / 404)  |
                +-------------------------+-------------------------+
                                          |
                         [ Reed-Solomon Inversion Decode ]
                                          |
                            +-------------v-------------+
                            | 100% Restored Plaintext!  |
                            +---------------------------+
```

---

## 📦 Installation

```bash
npm install freenet-blob
# or link locally:
npm link d:/freenet-blob
```

---

## 🚀 Quick Start

### 1. Uploading a File / Media Blob

```javascript
import { uploadBlob } from 'freenet-blob';

// In Node.js or Browser
const fileBytes = new Uint8Array([/* file or audio data */]);

const manifest = await uploadBlob({
  data: fileBytes,
  filename: 'track.flac',
  mimeType: 'audio/flac',
  encrypt: false, // Set true for private end-to-end encrypted storage
  shardSize: 256 * 1024, // 256 KB per Freenet contract
  parityRatio: 0.33,     // ~33% redundancy (M parity shards)
  onProgress: ({ progress, shardIndex, totalShards }) => {
    console.log(`Uploading: ${shardIndex}/${totalShards} (${progress}%)`);
  },
});

console.log('Manifest ready:', manifest);
```

### 2. Downloading & Auto-Reconstructing with $K$-of-$N$ Resilience

```javascript
import { downloadBlob } from 'freenet-blob';

const { data, filename, mimeType } = await downloadBlob({
  manifest,
  onProgress: ({ progress, retrievedCount, requiredCount }) => {
    console.log(`Retrieved ${retrievedCount}/${requiredCount} shards (${progress}%)`);
  },
});

console.log(`Downloaded ${filename} (${data.byteLength} bytes) with 100% integrity!`);
```

### 3. Auditing Health & Auto-Healing (Chunk Regeneration)

```javascript
import { inspectBlob, repairBlob } from 'freenet-blob';

// Check if any chunks were evicted or nodes went offline
const health = await inspectBlob({ manifest });
console.log(`Blob Health: ${health.health}% (${health.availableShards}/${health.totalShards} shards)`);

if (health.needsRepair) {
  console.log(`Missing shards detected: ${health.missingShards}. Healing...`);
  const result = await repairBlob({ manifest });
  console.log(`Repaired and re-published ${result.healedCount} shards!`);
}
```

---

## 🔌 Ecosystem Integrations

### In **Radica** (Decentralized Social Network)
Saves media > 768 KB (videos, photos, attachments):
```javascript
import { uploadBlob, downloadBlob } from 'freenet-blob';

// Inside Radica UI or backend:
const manifest = await uploadBlob({
  data: imageBytes,
  filename: 'high-res-photo.jpg',
  mimeType: 'image/jpeg',
});

// Store manifest reference in Radica post:
const post = {
  text: "Hello from Radica!",
  media_blob: manifest, // Replaces single-contract media_uri
};
```

### In **FreeTunes** (Decentralized Music Streaming)
Fault-tolerant audio streaming:
```javascript
import { downloadBlob } from 'freenet-blob';

// FreeTunes player fetches audio stream with zero stutter:
const { data } = await downloadBlob({ manifest: releaseTrack.blobManifest });
audioContext.decodeAudioData(data.buffer);
```

### In **Orto** (Decentralized Personal OS & Vault)
Archival personal file storage:
```javascript
import { uploadBlob } from 'freenet-blob';

const manifest = await uploadBlob({
  data: documentBytes,
  filename: 'taxes-2025.pdf',
  encrypt: true,
  key: userVaultKey, // End-to-end encrypted with user's vault key
});
```

### In **FreeHole** (Decentralized File Transfer)
Sovereign transfer with auto-healing:
```javascript
import { uploadBlob, downloadBlob } from 'freenet-blob';
// Already integrated in FreeHole Freenet mode!
```

---

## 🧪 Testing

```bash
npm test
```

Runs the full test suite:
- Single-chunk redundancy ($K=1, M=1$)
- Multi-chunk fault recovery with arbitrary lost shards
- High-throughput byte reconstruction
- Chunk regeneration & self-healing

---

## 📄 License

MIT © [scobru](https://github.com/scobru)
