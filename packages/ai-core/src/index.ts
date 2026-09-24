// Top-level barrel for @platform/ai-core. Audio Studio (Chunk 7) and
// apps/worker's audio job handler should import from here (or from
// "@platform/ai-core/audio" if a deep import is more convenient) rather
// than reaching into providers/audio/* directly — that keeps the "no
// vendor SDK outside providers/audio/*" rule enforceable by convention.

// NOTE: deliberately NOT `export * from "./audio"` — combining a star
// re-export with the named re-export from "./audio/bootstrap" below (which
// transitively imports "./audio/registry", a module "./audio" also
// re-exports) triggers a reproducible Node ESM bug where the star-exported
// bindings get silently dropped at runtime, even though "./audio" loads
// correctly in isolation. Explicit named re-exports sidestep it entirely.
export type {
	AudioProvider,
	GenerateAudioInput,
	GenerateAudioResult,
	VoiceDescriptor,
	ModelDescriptor,
	EstimateAudioCostInput,
	AudioCostEstimate,
	AiModelLookup,
	AiProviderActivityLookup
} from './audio';
export {
	ProviderNotRegisteredError,
	ProviderNotActiveError,
	ModelNotFoundError,
	ProviderRequestError,
	USD_PER_CREDIT,
	estimateCharacterBasedCost,
	prismaAiModelLookup,
	registerAudioProvider,
	clearAudioProviderRegistry,
	getAudioProvider,
	listRegisteredAudioProviderKeys,
	prismaAiProviderActivityLookup
} from './audio';
export { registerBuiltInAudioProviders, resetBuiltInAudioProviderRegistration } from './audio/bootstrap';
