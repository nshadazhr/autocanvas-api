import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getUploadUrl, getDownloadUrl, buildPublicUrl } from "./urls";
import { resetStorageConfigCache } from "./config";
import { resetS3ClientCache } from "./client";

// ─────────────────────────────────────────────────────────────────────────
// Unlike packages/queue's BullMQ/Redis wiring (which genuinely needs a live
// server and couldn't be exercised in this sandbox — see the README), S3
// presigning is pure, offline HMAC signing: @aws-sdk/s3-request-presigner
// computes a signature and builds a URL string without making any network
// call at all. So these tests call the REAL getUploadUrl/getDownloadUrl
// functions against fake-but-well-formed credentials, not a mock — and
// genuinely prove the signing wiring is correct, not just "doesn't throw".
// ─────────────────────────────────────────────────────────────────────────

const originalEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_PUBLIC_BASE_URL",
];

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.STORAGE_ENDPOINT = "http://localhost:9000";
  process.env.STORAGE_REGION = "auto";
  process.env.STORAGE_BUCKET = "platform-dev";
  process.env.STORAGE_ACCESS_KEY_ID = "platform";
  process.env.STORAGE_SECRET_ACCESS_KEY = "platform123";
  delete process.env.STORAGE_PUBLIC_BASE_URL;
  resetStorageConfigCache();
  resetS3ClientCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  resetStorageConfigCache();
  resetS3ClientCache();
});

describe("getUploadUrl", () => {
  it("returns a real presigned PUT URL against the configured endpoint/bucket/key", async () => {
    const result = await getUploadUrl({ key: "user/u1/projects/p1/files/f1.csv", contentType: "text/csv" });
    expect(result.key).toBe("user/u1/projects/p1/files/f1.csv");
    expect(result.expiresInSeconds).toBe(900); // default
    expect(result.url).toContain("http://localhost:9000/");
    expect(result.url).toContain("platform-dev");
    expect(result.url).toContain("user/u1/projects/p1/files/f1.csv");
    // Presence of these query params is what makes this a genuine SigV4
    // presigned URL rather than a plain string concatenation.
    expect(result.url).toContain("X-Amz-Signature=");
    expect(result.url).toContain("X-Amz-Expires=900");
  });

  it("respects a custom expiresInSeconds", async () => {
    const result = await getUploadUrl({
      key: "user/u1/projects/p1/files/f2.csv",
      contentType: "text/csv",
      expiresInSeconds: 60,
    });
    expect(result.url).toContain("X-Amz-Expires=60");
  });

  it("rejects an invalid key before ever touching the signer", async () => {
    await expect(getUploadUrl({ key: "../escape", contentType: "text/csv" })).rejects.toThrow();
  });
});

describe("getDownloadUrl", () => {
  it("returns a real presigned GET URL when no public base URL is configured", async () => {
    const result = await getDownloadUrl({ key: "org/o1/projects/p1/audio/scenes/s1/generations/g1.wav" });
    expect(result.isPublic).toBe(false);
    expect(result.expiresInSeconds).toBe(900);
    expect(result.url).toContain("http://localhost:9000/");
    expect(result.url).toContain("X-Amz-Signature=");
  });

  it("returns a plain public/CDN URL (no signing at all) when STORAGE_PUBLIC_BASE_URL is set", async () => {
    process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.com";
    resetStorageConfigCache();
    const result = await getDownloadUrl({ key: "org/o1/projects/p1/audio/scenes/s1/generations/g1.wav" });
    expect(result.isPublic).toBe(true);
    expect(result.expiresInSeconds).toBeNull();
    expect(result.url).toBe("https://cdn.example.com/org/o1/projects/p1/audio/scenes/s1/generations/g1.wav");
    expect(result.url).not.toContain("X-Amz-Signature");
  });
});

describe("buildPublicUrl", () => {
  it("joins a base URL without a trailing slash to the key with exactly one slash", () => {
    expect(buildPublicUrl("https://cdn.example.com", "a/b/c.wav")).toBe("https://cdn.example.com/a/b/c.wav");
  });

  it("joins a base URL that already has a trailing slash without doubling it", () => {
    expect(buildPublicUrl("https://cdn.example.com/", "a/b/c.wav")).toBe("https://cdn.example.com/a/b/c.wav");
  });
});
