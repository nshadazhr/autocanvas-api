import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAudioProvider,
  clearAudioProviderRegistry,
  getAudioProvider,
  listRegisteredAudioProviderKeys,
  type AiProviderActivityLookup,
} from "./registry";
import { ProviderNotRegisteredError, ProviderNotActiveError } from "./errors";
import type { AudioProvider } from "./types";

// A minimal fake AudioProvider — we're testing the registry's own logic
// here (registration + the two-layer "coded AND active" check), not any
// real provider's behavior, so every method beyond `key` is a stub.
function fakeProvider(key: string): AudioProvider {
  return {
    key,
    async generateAudio() {
      throw new Error("not implemented in fake");
    },
    async getVoices() {
      return [];
    },
    async getModels() {
      return [];
    },
    async estimateCost() {
      return { credits: 1, providerCostUsd: 0 };
    },
  };
}

// Fake activity lookup — a simple Set stands in for the AiProvider table's
// isActive column, so tests don't need a real Prisma client.
class FakeActivityLookup implements AiProviderActivityLookup {
  constructor(private readonly activeKeys: Set<string>) {}
  async isActive(key: string): Promise<boolean> {
    return this.activeKeys.has(key);
  }
}

beforeEach(() => {
  clearAudioProviderRegistry();
});

describe("registerAudioProvider / listRegisteredAudioProviderKeys", () => {
  it("starts empty and reflects registrations", () => {
    expect(listRegisteredAudioProviderKeys()).toEqual([]);
    registerAudioProvider(fakeProvider("mock_audio"));
    expect(listRegisteredAudioProviderKeys()).toEqual(["mock_audio"]);
  });

  it("re-registering the same key overwrites rather than duplicating", () => {
    const first = fakeProvider("mock_audio");
    const second = fakeProvider("mock_audio");
    registerAudioProvider(first);
    registerAudioProvider(second);
    expect(listRegisteredAudioProviderKeys()).toEqual(["mock_audio"]);
  });
});

describe("getAudioProvider", () => {
  it("throws ProviderNotRegisteredError when no code is registered for the key, even if it would be active", async () => {
    const lookup = new FakeActivityLookup(new Set(["elevenlabs"]));
    await expect(getAudioProvider("elevenlabs", lookup)).rejects.toThrow(ProviderNotRegisteredError);
  });

  it("throws ProviderNotActiveError when code is registered but the DB says inactive", async () => {
    registerAudioProvider(fakeProvider("elevenlabs"));
    const lookup = new FakeActivityLookup(new Set()); // nothing active
    await expect(getAudioProvider("elevenlabs", lookup)).rejects.toThrow(ProviderNotActiveError);
  });

  it("throws ProviderNotActiveError when there is no AiProvider row at all for the key", async () => {
    registerAudioProvider(fakeProvider("stale_key"));
    const lookup = new FakeActivityLookup(new Set()); // isActive() returns false for unknown rows too
    await expect(getAudioProvider("stale_key", lookup)).rejects.toThrow(ProviderNotActiveError);
  });

  it("returns the implementation when both layers agree: coded AND active", async () => {
    const provider = fakeProvider("mock_audio");
    registerAudioProvider(provider);
    const lookup = new FakeActivityLookup(new Set(["mock_audio"]));
    await expect(getAudioProvider("mock_audio", lookup)).resolves.toBe(provider);
  });

  it("neither layer alone is sufficient — active in DB but no code registered still fails", async () => {
    const lookup = new FakeActivityLookup(new Set(["openai_tts"]));
    await expect(getAudioProvider("openai_tts", lookup)).rejects.toThrow(ProviderNotRegisteredError);
  });
});
