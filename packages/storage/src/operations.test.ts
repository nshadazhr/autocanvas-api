import { describe, expect, it } from "vitest";
import { bodyToBuffer, downloadObject } from "./operations";
import { InvalidStorageKeyError } from "./errors";

describe("bodyToBuffer", () => {
  it("converts a transformToByteArray() stream stub into a Buffer with the same bytes", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 255]);
    const fakeBody = {
      transformToByteArray: async () => bytes,
    };

    const result = await bodyToBuffer(fakeBody);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(Buffer.from(bytes));
  });

  it("produces an empty Buffer for an empty byte array", async () => {
    const fakeBody = {
      transformToByteArray: async () => new Uint8Array([]),
    };

    const result = await bodyToBuffer(fakeBody);

    expect(result.length).toBe(0);
  });

  it("propagates rejection from transformToByteArray() rather than swallowing it", async () => {
    const fakeBody = {
      transformToByteArray: async () => {
        throw new Error("stream aborted");
      },
    };

    await expect(bodyToBuffer(fakeBody)).rejects.toThrow("stream aborted");
  });
});

describe("downloadObject", () => {
  it("validates the key before ever touching the network/S3 client", async () => {
    // A path-traversal key must be rejected by validateStorageKey() up front.
    // If this ever reaches the S3 client instead, it'll throw a
    // StorageConfigError (missing env vars) or a network error instead of
    // InvalidStorageKeyError, which would fail this assertion — proving the
    // validation genuinely happens before any S3 call.
    await expect(downloadObject("../etc/passwd")).rejects.toThrow(InvalidStorageKeyError);
  });
});
