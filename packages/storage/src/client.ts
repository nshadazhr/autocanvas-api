import { S3Client } from "@aws-sdk/client-s3";
import { getStorageConfig } from "./config";

// Singleton S3 client, same globalThis-caching trick used for the Prisma
// client (packages/database) and the Redis connection (packages/queue) —
// avoids reopening a fresh client per hot-reload in dev.
const globalForStorage = globalThis as unknown as { __s3Client?: S3Client };

export function getS3Client(): S3Client {
  if (!globalForStorage.__s3Client) {
    const config = getStorageConfig();
    globalForStorage.__s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // Required for MinIO (and most non-AWS S3-compatible services):
      // without this, the SDK builds virtual-hosted-style URLs
      // (bucket.endpoint/key) which MinIO/R2 don't route the same way AWS
      // does. Path-style (endpoint/bucket/key) works everywhere.
      forcePathStyle: true,
    });
  }
  return globalForStorage.__s3Client;
}

/** Test-only reset hook — production code never needs this. */
export function resetS3ClientCache(): void {
  globalForStorage.__s3Client = undefined;
}
