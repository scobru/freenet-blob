export interface FECMetadata {
  enabled: boolean;
  k: number;
  m: number;
  total: number;
  originalSize: number;
  shardSize: number;
}

export interface BlobManifest {
  v: number;
  generator: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: number;
  encrypted: boolean;
  fec: FECMetadata;
  chunks: string[];
  crypto: {
    salt: string;
    iv: string;
    algorithm: string;
  } | null;
}

export interface UploadOptions {
  data: Uint8Array | ArrayBuffer | Blob;
  filename?: string;
  mimeType?: string;
  encrypt?: boolean;
  key?: string | Uint8Array;
  shardSize?: number;
  parityRatio?: number;
  onProgress?: (progress: { progress: number; loaded: number; total: number; shardIndex: number; totalShards: number }) => void;
  onStatusChange?: (status: any) => void;
  freenetOptions?: { wsUrl?: string; timeoutMs?: number; wasmPath?: string };
}

export interface DownloadOptions {
  manifest: BlobManifest;
  key?: string | Uint8Array;
  onProgress?: (progress: { progress: number; loaded: number; total: number; retrievedCount: number; requiredCount: number }) => void;
  onStatusChange?: (status: any) => void;
  freenetOptions?: { wsUrl?: string; timeoutMs?: number };
}

export function uploadBlob(options: UploadOptions): Promise<BlobManifest>;

export function downloadBlob(options: DownloadOptions): Promise<{
  data: Uint8Array;
  filename: string;
  mimeType: string;
  size: number;
}>;

export function inspectBlob(options: { manifest: BlobManifest; freenetOptions?: any }): Promise<{
  totalShards: number;
  requiredShards: number;
  availableShards: number;
  missingShards: number[];
  health: number;
  isRecoverable: boolean;
  needsRepair: boolean;
}>;

export function repairBlob(options: {
  manifest: BlobManifest;
  key?: string | Uint8Array;
  onStatusChange?: (status: any) => void;
  freenetOptions?: any;
}): Promise<{ status: string; healedCount: number; missingCount: number }>;

export function encodeFEC(dataBytes: Uint8Array, options?: { shardSize?: number; parityCount?: number; redundancyRatio?: number }): {
  shards: Array<{ index: number; isParity: boolean; data: Uint8Array }>;
  k: number;
  m: number;
  totalShards: number;
  originalSize: number;
  shardSize: number;
};

export function decodeFEC(receivedShards: Array<{ index: number; data: Uint8Array }>, fecMetadata: FECMetadata): Uint8Array;

export function regenerateShard(
  receivedShards: Array<{ index: number; data: Uint8Array }>,
  targetIndex: number,
  fecMetadata: FECMetadata
): Uint8Array;
