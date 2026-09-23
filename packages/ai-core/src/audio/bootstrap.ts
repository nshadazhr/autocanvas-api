import { registerAudioProvider } from "./registry";
import { MockAudioProvider } from "../../providers/audio/mock-provider";
import { ElevenLabsProvider } from "../../providers/audio/elevenlabs-provider";

// ─────────────────────────────────────────────────────────────────────────
// Single place that wires provider CODE into the in-memory registry. Call
// this once at process startup (apps/web, apps/worker) — same idea as
// packages/queue's defineWorker() being called once per module.
//
// Adding a new real provider (openai_tts, azure_speech, ...) later means:
//   1. write providers/audio/<name>-provider.ts implementing AudioProvider
//   2. add one line here
//   3. seed an AiProvider + AiModel row for it (packages/database seed.ts)
// No other file in the codebase needs to change — that's the point of the
// registry/DB split described in registry.ts.
// ─────────────────────────────────────────────────────────────────────────

let registered = false;

export function registerBuiltInAudioProviders(): void {
  if (registered) return; // idempotent — safe to call from multiple entrypoints
  registerAudioProvider(MockAudioProvider);
  registerAudioProvider(ElevenLabsProvider);
  registered = true;
}

/** Test/reset hook, pairs with clearAudioProviderRegistry() — production code never needs this. */
export function resetBuiltInAudioProviderRegistration(): void {
  registered = false;
}
