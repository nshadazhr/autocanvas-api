import { estimateCharacterBasedCost } from "../../src/audio/cost";
import type {
  AudioProvider,
  EstimateAudioCostInput,
  GenerateAudioInput,
  GenerateAudioResult,
  ModelDescriptor,
  VoiceDescriptor,
} from "../../src/audio/types";

// ─────────────────────────────────────────────────────────────────────────
// Matches the "mock_audio" row seeded in packages/database/prisma/seed.ts
// (key: "mock_audio", model key: "mock_v1", costPerUnit: 0). Exists so
// Audio Studio (Chunk 7) and this chunk's own tests can exercise the full
// generate-audio pipeline — enqueue, worker picks it up, provider "call",
// credits consumed — without needing a real ElevenLabs API key or making
// a real network request. It's a real, wired-in AudioProvider, not a test
// double that lives only in test files.
//
// The "audio" it returns is a minimal valid WAV file: a proper 44-byte
// RIFF/WAVE header describing zero PCM frames, i.e. a real, parseable,
// silent, zero-length audio file. Good enough to prove storage/playback
// wiring later without shipping a fake non-audio buffer that would fail
// the moment something tries to actually decode it.
// ─────────────────────────────────────────────────────────────────────────

function buildSilentWavHeader(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36, 4); // file size - 8, no data chunk beyond the header
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(32000, 28); // byte rate (sampleRate * blockAlign)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0, 40); // 0 bytes of actual sample data
  return header;
}

export const MockAudioProvider: AudioProvider = {
  key: "mock_audio",

  async generateAudio(input: GenerateAudioInput): Promise<GenerateAudioResult> {
    // Deliberately synchronous-fast (no artificial delay, no network) —
    // tests and local dev shouldn't have to wait to prove the pipeline
    // works. A "slow mock" that simulates latency is a reasonable future
    // addition but isn't needed for what this chunk proves.
    return {
      audio: buildSilentWavHeader(),
      mimeType: "audio/wav",
      durationSeconds: 0,
      billableUnits: input.text.length,
    };
  },

  async getVoices(): Promise<VoiceDescriptor[]> {
    return [
      { providerVoiceId: "mock-voice-a", name: "Mock Voice A", language: "en-US", gender: "male" },
      { providerVoiceId: "mock-voice-b", name: "Mock Voice B", language: "en-US", gender: "female" },
    ];
  },

  async getModels(): Promise<ModelDescriptor[]> {
    return [
      {
        key: "mock_v1",
        name: "Mock Model (returns a silent clip instantly)",
        capabilities: { languages: ["*"] },
      },
    ];
  },

  async estimateCost(input: EstimateAudioCostInput) {
    return estimateCharacterBasedCost("mock_audio", input.modelKey, input.text.length);
  },
};
