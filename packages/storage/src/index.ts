export { getStorageConfig, resetStorageConfigCache, type StorageConfig } from "./config";
export { getS3Client, resetS3ClientCache } from "./client";

export {
  validateStorageKey,
  buildOwnerScope,
  buildProjectFileKey,
  buildAudioGenerationKey,
  buildAudioExportKey,
  buildInvoicePdfKey,
  type ProjectFileKeyInput,
  type AudioGenerationKeyInput,
  type AudioExportKeyInput,
  type InvoicePdfKeyInput,
} from "./keys";

export {
  getUploadUrl,
  getDownloadUrl,
  buildPublicUrl,
  type GetUploadUrlInput,
  type GetUploadUrlResult,
  type GetDownloadUrlInput,
  type GetDownloadUrlResult,
} from "./urls";

export {
  uploadBuffer,
  deleteObject,
  headObject,
  downloadObject,
  bodyToBuffer,
  type UploadBufferInput,
  type ObjectMetadata,
} from "./operations";

export { StorageConfigError, InvalidStorageKeyError, StorageOperationError } from "./errors";
