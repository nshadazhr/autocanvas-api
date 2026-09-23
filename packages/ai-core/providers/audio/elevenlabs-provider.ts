import { estimateCharacterBasedCost } from "../../src/audio/cost";
import { ProviderRequestError } from "../../src/audio/errors";
import type {
  AudioProvider,
  EstimateAudioCostInput,
  GenerateAudioInput,
  GenerateAudioResult,
  ModelDescriptor,
  VoiceDescriptor,
} from "../../src/audio/types";

// ─────────────────────────────────────────────────────────────────────────
// Real provider #1. Matches the "elevenlabs" row seeded in
// packages/database/prisma/seed.ts (model key: "eleven_flash_v2").
//
// The API key is read from process.env, NOT from AiProvider.config in the
// database — config is fine for non-secret tuning knobs, but a secret
// like this belongs in env vars / a secrets manager, never in a DB column
// an admin UI might one day render back onto a screen.
// ─────────────────────────────────────────────────────────────────────────

const API_BASE = "https://api.elevenlabs.io/v1";

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new ProviderRequestError(
      "elevenlabs",
      "ELEVENLABS_API_KEY is not set. Add it to your .env — see .env.example.",
    );
  }
  return key;
}

async function elevenLabsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "xi-api-key": getApiKey(), ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable response body>");
    throw new ProviderRequestError(
      "elevenlabs",
      `${init.method ?? "GET"} ${path} -> HTTP ${response.status}: ${body}`,
    );
  }

  return response;
}

export const ElevenLabsProvider: AudioProvider = {
  key: "elevenlabs",

  async generateAudio(input: GenerateAudioInput): Promise<GenerateAudioResult> {
    const response = await elevenLabsFetch(
      `/text-to-speech/${encodeURIComponent(input.providerVoiceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: input.text,
          model_id: input.modelKey,
          voice_settings: {
            // Reasonable defaults when the scene doesn't specify anything
            // more precise — ElevenLabs requires stability/similarity_boost
            // to be present at all.
            stability: 0.5,
            similarity_boost: 0.75,
            ...(input.speed !== undefined ? { speed: input.speed } : {}),
          },
        }),
      },
    );

    const arrayBuffer = await response.arrayBuffer();
    return {
      audio: Buffer.from(arrayBuffer),
      mimeType: "audio/mpeg",
      billableUnits: input.text.length,
    };
  },

  async getVoices(): Promise<VoiceDescriptor[]> {
    const response = await elevenLabsFetch("/voices");
    const data = (await response.json()) as {
      voices: Array<{
        voice_id: string;
        name: string;
        labels?: Record<string, string>;
        preview_url?: string;
      }>;
    };

    return data.voices.map((v) => ({
      providerVoiceId: v.voice_id,
      name: v.name,
      language: v.labels?.language ?? "en",
      gender: v.labels?.gender,
      previewUrl: v.preview_url,
    }));
  },

  async getModels(): Promise<ModelDescriptor[]> {
    const response = await elevenLabsFetch("/models");
    const data = (await response.json()) as Array<{
      model_id: string;
      name: string;
      languages?: unknown[];
      can_do_text_to_speech?: boolean;
    }>;

    return data
      .filter((m) => m.can_do_text_to_speech !== false)
      .map((m) => ({ key: m.model_id, name: m.name, capabilities: { languages: m.languages ?? [] } }));
  },

  async estimateCost(input: EstimateAudioCostInput) {
    return estimateCharacterBasedCost("elevenlabs", input.modelKey, input.text.length);
  },
};
