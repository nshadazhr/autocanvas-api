import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getStorageConfig, resetStorageConfigCache } from "./config";
import { StorageConfigError } from "./errors";

const REQUIRED_VARS = ["STORAGE_ENDPOINT", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"];

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetStorageConfigCache();
  for (const key of [...REQUIRED_VARS, "STORAGE_REGION", "STORAGE_PUBLIC_BASE_URL"]) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(originalEnv)) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  resetStorageConfigCache();
});

function setAllRequiredVars() {
  process.env.STORAGE_ENDPOINT = "http://localhost:9000";
  process.env.STORAGE_BUCKET = "platform-dev";
  process.env.STORAGE_ACCESS_KEY_ID = "platform";
  process.env.STORAGE_SECRET_ACCESS_KEY = "platform123";
}

describe("getStorageConfig", () => {
  it.each(REQUIRED_VARS)("throws StorageConfigError when %s is missing", (missingVar) => {
    setAllRequiredVars();
    delete process.env[missingVar];
    expect(() => getStorageConfig()).toThrow(StorageConfigError);
  });

  it("defaults STORAGE_REGION to 'auto' when unset", () => {
    setAllRequiredVars();
    const config = getStorageConfig();
    expect(config.region).toBe("auto");
  });

  it("uses STORAGE_REGION when explicitly set", () => {
    setAllRequiredVars();
    process.env.STORAGE_REGION = "us-east-1";
    expect(getStorageConfig().region).toBe("us-east-1");
  });

  it("defaults publicBaseUrl to null when STORAGE_PUBLIC_BASE_URL is unset or empty", () => {
    setAllRequiredVars();
    expect(getStorageConfig().publicBaseUrl).toBeNull();
  });

  it("caches the config across calls (mutating env after the first call has no effect)", () => {
    setAllRequiredVars();
    const first = getStorageConfig();
    process.env.STORAGE_BUCKET = "changed-later";
    const second = getStorageConfig();
    expect(second).toBe(first);
    expect(second.bucket).toBe("platform-dev");
  });
});
