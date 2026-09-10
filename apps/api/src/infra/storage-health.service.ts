import { Injectable } from '@nestjs/common';
import { loadEnv, storageEnvSchema } from '@spectra/config';
import { S3ObjectStorageProvider } from '@spectra/storage';

/**
 * Object-storage reachability for readiness (ADR-0033).
 *
 * Reports only whether the bucket answers — never the endpoint credentials,
 * and never a listing of its contents.
 */
@Injectable()
export class StorageHealthService {
  private provider: S3ObjectStorageProvider | null = null;

  private get storage(): S3ObjectStorageProvider {
    this.provider ??= new S3ObjectStorageProvider(loadEnv(storageEnvSchema));
    return this.provider;
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.storage.ensureBucket();
      return true;
    } catch {
      return false;
    }
  }
}
