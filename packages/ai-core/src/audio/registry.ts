import { prisma } from "@platform/database";
import { ProviderNotRegisteredError, ProviderNotActiveError } from "./errors";
import type { AudioProvider } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Two independent layers, deliberately not merged into one lookup:
//
//   1. `implementations` (in-memory, this process) — the actual CODE for
//      each provider. Populated by calling `registerAudioProvider()`, once
//      per process, at startup (see bootstrap.ts).
//
//   2. `AiProvider` (the database table) — whether a given provider key is
//      currently ACTIVE. An admin flips `isActive` off in the database
//      (Chunk 8's admin panel will do this with a button, no deploy) and
//      every process picks that up on the next lookup, without a restart.
//
// `getAudioProvider(key)` requires BOTH: code has to exist for it, and the
// database has to currently allow it. Neither layer alone is sufficient —
// a provider can be coded but administratively disabled, or (in theory) a
// stale/typo'd key can exist in the DB with no code behind it yet.
// ─────────────────────────────────────────────────────────────────────────

const implementations = new Map<string, AudioProvider>();

export function registerAudioProvider(provider: AudioProvider): void {
  implementations.set(provider.key, provider);
}

/** Test/reset hook — production code never needs this, tests do. */
export function clearAudioProviderRegistry(): void {
  implementations.clear();
}

/** Structural port so provider-activity lookups can be unit tested without a generated Prisma client. */
export interface AiProviderActivityLookup {
  isActive(key: string): Promise<boolean>;
}

export const prismaAiProviderActivityLookup: AiProviderActivityLookup = {
  async isActive(key) {
    const row = await prisma.aiProvider.findUnique({ where: { key } });
    return row?.isActive ?? false;
  },
};

export async function getAudioProvider(
  key: string,
  activityLookup: AiProviderActivityLookup = prismaAiProviderActivityLookup,
): Promise<AudioProvider> {
  const impl = implementations.get(key);
  if (!impl) {
    throw new ProviderNotRegisteredError(key);
  }

  const active = await activityLookup.isActive(key);
  if (!active) {
    throw new ProviderNotActiveError(key);
  }

  return impl;
}

/** For admin/debug UI: which provider keys does THIS process have code for right now. */
export function listRegisteredAudioProviderKeys(): string[] {
  return Array.from(implementations.keys());
}
