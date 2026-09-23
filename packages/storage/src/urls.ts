import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Client } from "./client";
import { getStorageConfig } from "./config";
import { validateStorageKey } from "./keys";

const DEFAULT_EXPIRES_SECONDS = 900; // 15 minutes

export interface GetUploadUrlInput {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}

export interface GetUploadUrlResult {
  url: string;
  key: string;
  expiresInSeconds: number;
}

/**
 * Presigned PUT URL — for the browser to upload directly to the bucket
 * (e.g. a CSV import in Audio Studio) without the file ever passing
 * through apps/web's own server. The caller still owns creating the
 * ProjectFile row (with this same `key`) once the client confirms the
 * upload succeeded — this function only proves the URL is safe to hand
 * to a browser for exactly one object, for a limited time.
 */
export async function getUploadUrl(input: GetUploadUrlInput): Promise<GetUploadUrlResult> {
  const key = validateStorageKey(input.key);
  const config = getStorageConfig();
  const expiresInSeconds = input.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: input.contentType,
  });
  const url = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
  return { url, key, expiresInSeconds };
}

export interface GetDownloadUrlInput {
  key: string;
  expiresInSeconds?: number;
}

export interface GetDownloadUrlResult {
  url: string;
  key: string;
  /** true when this is a stable public/CDN URL (never expires); false when it's a time-limited presigned URL. */
  isPublic: boolean;
  expiresInSeconds: number | null;
}

/**
 * Read URL for a stored object. Prefers the public CDN base URL when one
 * is configured (prod, once R2 sits behind a custom domain) — that's
 * cheaper and cacheable. Falls back to a presigned GET URL otherwise
 * (local dev against MinIO, or a bucket that's intentionally private).
 */
export async function getDownloadUrl(input: GetDownloadUrlInput): Promise<GetDownloadUrlResult> {
  const key = validateStorageKey(input.key);
  const config = getStorageConfig();

  if (config.publicBaseUrl) {
    return {
      url: buildPublicUrl(config.publicBaseUrl, key),
      key,
      isPublic: true,
      expiresInSeconds: null,
    };
  }

  const expiresInSeconds = input.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS;
  const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
  const url = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
  return { url, key, isPublic: false, expiresInSeconds };
}

/** Pure helper, split out from getDownloadUrl so the URL-joining logic itself can be unit tested without env vars or network. */
export function buildPublicUrl(baseUrl: string, key: string): string {
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmedBase}/${key}`;
}
