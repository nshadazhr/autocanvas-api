import { StorageConfigError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────
// Cloudflare R2, MinIO (local dev), and AWS S3 itself all speak the same
// S3 API — that's the whole point of "S3-compatible". So unlike
// packages/ai-core's AudioProvider (where ElevenLabs/OpenAI/Azure genuinely
// have different request/response shapes and need separate adapters),
// storage doesn't need a per-vendor abstraction layer at all: one
// S3Client, pointed at a different endpoint per environment, is enough.
// Swapping MinIO for real R2 in prod is a .env change, not a code change.
// ─────────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Set once a CDN (e.g. a custom domain in front of R2) sits in front of
   * the bucket in prod. When set, getPublicUrl()/getDownloadUrl() return a
   * plain CDN URL instead of a presigned one — no expiry, cacheable, no
   * per-request signing cost. Empty in local dev (MinIO isn't public), so
   * downloads fall back to presigned GET URLs.
   */
  publicBaseUrl: string | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new StorageConfigError(name);
  }
  return value;
}

let cachedConfig: StorageConfig | undefined;

export function getStorageConfig(): StorageConfig {
  if (!cachedConfig) {
    cachedConfig = {
      endpoint: requireEnv("STORAGE_ENDPOINT"),
      region: process.env.STORAGE_REGION || "auto",
      bucket: requireEnv("STORAGE_BUCKET"),
      accessKeyId: requireEnv("STORAGE_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("STORAGE_SECRET_ACCESS_KEY"),
      publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL || null,
    };
  }
  return cachedConfig;
}

/** Test-only reset hook — production code never needs this. */
export function resetStorageConfigCache(): void {
  cachedConfig = undefined;
}
