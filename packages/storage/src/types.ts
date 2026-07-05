/**
 * Provider-neutral object storage port. MinIO locally, any S3-compatible
 * store in production. Callers never touch provider SDKs directly.
 */

export interface PutObjectInput {
  key: string;
  body: Uint8Array | Buffer | string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface StoredObjectInfo {
  key: string;
  sizeBytes: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
}

export interface SignedUploadUrlInput {
  key: string;
  contentType: string;
  /** Server-side cap; enforced again on completion by validators. */
  maxSizeBytes: number;
  expiresInSeconds?: number;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectStorageProvider {
  readonly providerId: string;
  ensureBucket(): Promise<void>;
  putObject(input: PutObjectInput): Promise<StoredObjectInfo>;
  getObject(key: string): Promise<Buffer>;
  headObject(key: string): Promise<StoredObjectInfo | null>;
  deleteObject(key: string): Promise<void>;
  createSignedUploadUrl(input: SignedUploadUrlInput): Promise<SignedUrl>;
  createSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<SignedUrl>;
}

/**
 * Malware-scanning integration point. Uploads are held in PENDING until a
 * scanner delivers a verdict. Phase 1 ships the port only — wire a real
 * engine (e.g. ClamAV sidecar or a managed scanning service) before
 * accepting untrusted uploads in production.
 */
export type MalwareScanVerdict = 'CLEAN' | 'INFECTED' | 'UNSCANNABLE';

export interface MalwareScanResult {
  verdict: MalwareScanVerdict;
  engine: string;
  details?: string;
  scannedAt: Date;
}

export interface MalwareScanProvider {
  readonly engineId: string;
  scanObject(storageKey: string): Promise<MalwareScanResult>;
}
