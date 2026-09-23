// ─────────────────────────────────────────────────────────────────────────
// Generic job-queue types.
//
// Nothing in this file (or in worker-logic.ts) mentions "audio", "script",
// or any other content module by name — `module` and `jobType` are plain
// strings supplied by the caller. This is deliberate: the Audio Studio
// module (Chunk 7+) is just one caller of this package, not something the
// queue package knows about. A future Script/Image/Video Studio calls the
// exact same `enqueueJob`/`defineWorker` API with a different `module`
// string and a different handler.
// ─────────────────────────────────────────────────────────────────────────

export interface EnqueueJobInput {
  userId: string;
  projectId?: string;
  creditAccountId: string;
  /** e.g. "audio", "script", "_system" (used by the demo/echo jobs in this chunk) */
  module: string;
  /** e.g. "generate_scene", "merge_audio", "echo" */
  jobType: string;
  payload: Record<string, unknown>;
  provider?: string;
  model?: string;
  creditsToReserve: number;
  maxAttempts?: number;
}

export interface EnqueueJobResult {
  jobId: string;
}

export interface JobHandlerContext<TPayload = Record<string, unknown>> {
  jobId: string;
  attempt: number;
  payload: TPayload;
}

export type JobHandler<TPayload = Record<string, unknown>, TResult = unknown> = (
  ctx: JobHandlerContext<TPayload>,
) => Promise<TResult>;

/** One worker process handles one `module`'s queue, dispatching by `jobType`. */
export type JobHandlerMap = Record<string, JobHandler>;
