import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageEnv } from '@spectra/config';

import type {
  ObjectStorageProvider,
  PutObjectInput,
  SignedUploadUrlInput,
  SignedUrl,
  StoredObjectInfo,
} from './types';

const DEFAULT_EXPIRY_SECONDS = 15 * 60;

/**
 * S3-compatible implementation used for both MinIO (local) and production
 * object stores. Credentials always come from validated environment config.
 */
export class S3ObjectStorageProvider implements ObjectStorageProvider {
  public readonly providerId = 's3-compatible';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(env: StorageEnv) {
    this.bucket = env.STORAGE_BUCKET;
    this.client = new S3Client({
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.STORAGE_ACCESS_KEY,
        secretAccessKey: env.STORAGE_SECRET_KEY,
      },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async putObject(input: PutObjectInput): Promise<StoredObjectInfo> {
    const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: body,
        ContentType: input.contentType,
        Metadata: input.metadata,
      }),
    );
    return {
      key: input.key,
      sizeBytes: body.byteLength,
      contentType: input.contentType,
      ...(result.ETag ? { etag: result.ETag } : {}),
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error(`Object ${key} has no body`);
    }
    return Buffer.from(bytes);
  }

  async headObject(key: string): Promise<StoredObjectInfo | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        sizeBytes: result.ContentLength ?? 0,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.LastModified ? { lastModified: result.LastModified } : {}),
      };
    } catch {
      return null;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createSignedUploadUrl(input: SignedUploadUrlInput): Promise<SignedUrl> {
    const expiresIn = input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.maxSizeBytes,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async createSignedDownloadUrl(
    key: string,
    expiresInSeconds = DEFAULT_EXPIRY_SECONDS,
  ): Promise<SignedUrl> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }
}
