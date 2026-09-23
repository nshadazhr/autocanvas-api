export class StorageConfigError extends Error {
  constructor(missingVar: string) {
    super(
      `${missingVar} is not set. Copy .env.example to .env and point it at your ` +
        `local MinIO (see infrastructure/docker/docker-compose.yml) or your real R2 bucket.`,
    );
    this.name = "StorageConfigError";
  }
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`Invalid storage key "${key}": ${reason}`);
    this.name = "InvalidStorageKeyError";
  }
}

export class StorageOperationError extends Error {
  constructor(operation: string, key: string, cause?: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Storage operation "${operation}" failed for key "${key}": ${causeMessage}`);
    this.name = "StorageOperationError";
  }
}
