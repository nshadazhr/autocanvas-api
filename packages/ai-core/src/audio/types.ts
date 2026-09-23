// ─────────────────────────────────────────────────────────────────────────
// The AudioProvider contract. Nothing outside this package (and outside
// providers/audio/*) should ever import ElevenLabs/OpenAI/Azure SDKs
// directly — every caller (the worker, the Audio Studio UI's API routes)
// goes through `getAudioProvider(key)` from registry.ts and talks to
// whatever comes back purely through this interface. Swapping ElevenLabs
// for a different vendor, or adding a second real provider, means writing
// one new file in providers/audio/ and registering it — nothing here, in
// packages/queue, or in apps/worker changes.
//
// This is intentionally narrower than "every feature every TTS vendor
// might have" — it's the shape Audio Studio (Chunk 7) actually needs.
// Provider-specific extras belong in that provider's own `config` (DB
// `AiProvider.config` / `AiModel.capabilities`), not new interface methods.
// ─────────────────────────────────────────────────────────────────────────

export interface GenerateAudioInput {
  text: string;
  /** The provider's own voice id — e.g. VoiceProfile.providerVoiceId, not our internal VoiceProfile.id. */
  providerVoiceId: string;
  modelKey: string;
  language?: string;
  /** 0.5–2.0 typically; providers that don't support this just ignore it. */
  speed?: number;
  /** -20..20 semitones-ish; provider-specific range, best-effort. */
  pitch?: number;
  style?: string;
  emotion?: string;
}

export interface GenerateAudioResult {
  audio: Buffer;
  mimeType: string;
  /** Only set when the provider can tell us up front; otherwise the caller measures the file itself. */
  durationSeconds?: number;
  /** How many billable units (usually characters) this generation actually consumed, for reconciliation against the pre-generation estimate. */
  billableUnits: number;
}

export interface VoiceDescriptor {
  providerVoiceId: string;
  name: string;
  language: string;
  gender?: string;
  previewUrl?: string;
}

export interface ModelDescriptor {
  key: string;
  name: string;
  capabilities: Record<string, unknown>;
}

export interface EstimateAudioCostInput {
  text: string;
  modelKey: string;
}

export interface AudioCostEstimate {
  /** Platform credits this generation will reserve — always a whole number, always >= 1. */
  credits: number;
  /** What we expect to actually pay the provider, in USD — for margin tracking, not shown to end users. */
  providerCostUsd: number;
}

export interface AudioProvider {
  /** Must match this provider's `AiProvider.key` row in the database — see registry.ts. */
  readonly key: string;

  generateAudio(input: GenerateAudioInput): Promise<GenerateAudioResult>;
  getVoices(): Promise<VoiceDescriptor[]>;
  getModels(): Promise<ModelDescriptor[]>;
  estimateCost(input: EstimateAudioCostInput): Promise<AudioCostEstimate>;
}
