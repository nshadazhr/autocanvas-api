import { describe, expect, it } from "vitest";
import { extensionForAudioMimeType, extensionFromStorageKey } from "./mime";

describe("extensionForAudioMimeType", () => {
  it("maps known audio mime types to their conventional extension", () => {
    expect(extensionForAudioMimeType("audio/wav")).toBe("wav");
    expect(extensionForAudioMimeType("audio/mpeg")).toBe("mp3");
    expect(extensionForAudioMimeType("audio/ogg")).toBe("ogg");
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(extensionForAudioMimeType(" AUDIO/WAV ")).toBe("wav");
  });

  it("falls back to the mime subtype for unknown-but-well-formed mime types", () => {
    expect(extensionForAudioMimeType("audio/aac")).toBe("aac");
  });

  it("falls back to 'bin' for a mime type with no usable subtype", () => {
    expect(extensionForAudioMimeType("garbage")).toBe("bin");
  });
});

describe("extensionFromStorageKey", () => {
  it("reads the extension off a well-formed key", () => {
    expect(extensionFromStorageKey("user/u1/projects/p1/audio/scenes/s1/generations/g1.wav")).toBe("wav");
  });

  it("returns 'bin' when there is no dot after the last slash", () => {
    expect(extensionFromStorageKey("user/u1/projects/p1/file-without-extension")).toBe("bin");
  });

  it("returns 'bin' for a key ending in a bare dot", () => {
    expect(extensionFromStorageKey("user/u1/file.")).toBe("bin");
  });
});
