export type {
  AudioProvider,
  GenerateAudioInput,
  GenerateAudioResult,
  VoiceDescriptor,
  ModelDescriptor,
  EstimateAudioCostInput,
  AudioCostEstimate,
} from "./types";

export {
  ProviderNotRegisteredError,
  ProviderNotActiveError,
  ModelNotFoundError,
  ProviderRequestError,
} from "./errors";

export {
  USD_PER_CREDIT,
  estimateCharacterBasedCost,
  prismaAiModelLookup,
  type AiModelLookup,
} from "./cost";

export {
  registerAudioProvider,
  clearAudioProviderRegistry,
  getAudioProvider,
  listRegisteredAudioProviderKeys,
  prismaAiProviderActivityLookup,
  type AiProviderActivityLookup,
} from "./registry";
