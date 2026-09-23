import { prisma } from "@platform/database";
import { enqueueJob } from "./enqueue";
import { JobNotFoundError } from "./errors";
import type { EnqueueJobResult } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Manual retry for a permanently-FAILED job — the operation `apps/admin`'s
// Failed Jobs view (Chunk 8) needs. Deliberately does NOT try to resurrect
// the original BullMQ job (e.g. via BullMQ's own `Job.retry()`): by the
// time a Job's DB status is FAILED, `handleAttemptOutcome` has already
// refunded its credit reservation (see worker-logic.ts), so there is
// nothing left to "resume" — the only correct move is to reserve credits
// again and push a brand new attempt, exactly like the original request
// did. Reusing `enqueueJob` for that means retry gets the exact same
// reserve-then-push ordering/rollback guarantees as every other job,
// instead of a second, subtly different code path to keep in sync.
//
// This intentionally creates a NEW `Job` row (new id) rather than mutating
// the old FAILED one in place — the old row stays exactly as it was, a
// permanent audit record of "this attempt failed on <date>, here's why."
// ─────────────────────────────────────────────────────────────────────────

export class JobNotFailedError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly status: string,
  ) {
    super(`Job ${jobId} is not FAILED (current status: ${status}) — only failed jobs can be retried.`);
    this.name = "JobNotFailedError";
  }
}

export class JobMissingCreditAccountError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job ${jobId} has no creditAccountId on record and cannot be re-reserved for a retry.`);
    this.name = "JobMissingCreditAccountError";
  }
}

export async function retryFailedJob(jobId: string): Promise<EnqueueJobResult> {
  const original = await prisma.job.findUnique({ where: { id: jobId } });
  if (!original) {
    throw new JobNotFoundError(jobId);
  }
  if (original.status !== "FAILED") {
    throw new JobNotFailedError(jobId, original.status);
  }
  if (!original.creditAccountId) {
    throw new JobMissingCreditAccountError(jobId);
  }

  return enqueueJob({
    userId: original.userId,
    projectId: original.projectId ?? undefined,
    creditAccountId: original.creditAccountId,
    module: original.module,
    jobType: original.jobType,
    payload: original.payload as Record<string, unknown>,
    creditsToReserve: original.creditsReserved,
    provider: original.provider ?? undefined,
    model: original.model ?? undefined,
    maxAttempts: original.maxAttempts,
  });
}
