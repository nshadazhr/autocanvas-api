export class ProviderNotRegisteredError extends Error {
  constructor(public readonly key: string) {
    super(
      `No AudioProvider implementation is registered for key "${key}". ` +
        `Did you forget to call registerBuiltInAudioProviders() (or register a ` +
        `custom one) during app startup?`,
    );
    this.name = "ProviderNotRegisteredError";
  }
}

export class ProviderNotActiveError extends Error {
  constructor(public readonly key: string) {
    super(
      `AiProvider "${key}" exists but is not active (isActive=false in the ` +
        `database) or has no matching row at all — an admin has this toggled ` +
        `off, or it was never seeded.`,
    );
    this.name = "ProviderNotActiveError";
  }
}

export class ModelNotFoundError extends Error {
  constructor(public readonly providerKey: string, public readonly modelKey: string) {
    super(`No AiModel row found for provider "${providerKey}" with key "${modelKey}".`);
    this.name = "ModelNotFoundError";
  }
}

export class ProviderRequestError extends Error {
  constructor(
    public readonly providerKey: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${providerKey}] ${message}`);
    this.name = "ProviderRequestError";
  }
}
