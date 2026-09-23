// Top-level barrel for @platform/ai-core. Audio Studio (Chunk 7) and
// apps/worker's audio job handler should import from here (or from
// "@platform/ai-core/audio" if a deep import is more convenient) rather
// than reaching into providers/audio/* directly — that keeps the "no
// vendor SDK outside providers/audio/*" rule enforceable by convention.

export * from "./audio";
export { registerBuiltInAudioProviders, resetBuiltInAudioProviderRegistration } from "./audio/bootstrap";
