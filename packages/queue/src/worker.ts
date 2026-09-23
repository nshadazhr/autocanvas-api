import { Worker, type Job as BullJob } from "bullmq";
import { prisma } from "@platform/database";
import { consumeCredits, refundCredits } from "@platform/credits";
import { getRedisConnection } from "./connection";
import { handleAttemptOutcome, type JobRecord, type WorkerActions } from "./worker-logic";
import { UnknownJobTypeError } from "./errors";
import type { JobHandlerMap } from "./types";

// Wires the real Prisma + @platform/credits calls into the WorkerActions
// port that worker-logic.ts's pure `handleAttemptOutcome` depends on. Kept
// separate from that function on purpose — see worker-logic.ts's top
// comment for why.
const realActions: WorkerActions = {
  async recordAttemptResult(jobId, attemptNumber, outcome) {
    await prisma.jobAttempt.create({
      data: {
        jobId,
        attemptNumber,
        status: outcome.success ? "COMPLETED" : "FAILED",
        error: outcome.success ? null : outcome.error,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
  },
  async markJobCompleted(jobId, creditsConsumed) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED", creditsConsumed, finishedAt: new Date() },
    });
  },
  async markJobRetrying(jobId, error) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "RETRYING", error },
    });
  },
  async markJobFailed(jobId, error) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "FAILED", error, finishedAt: new Date() },
    });
  },
  async consumeCredits(accountId, amount, referenceId) {
    await consumeCredits(accountId, BigInt(amount), { referenceType: "job", referenceId });
  },
  async refundCredits(accountId, amount, referenceId) {
    await refundCredits(accountId, BigInt(amount), { referenceType: "job", referenceId });
  },
};

/**
 * Starts a BullMQ Worker for `module`'s queue. `handlers` maps jobType ->
 * handler function; a job whose `jobType` isn't in the map fails immediately
 * (and, since that's a programming error rather than a transient failure,
 * still goes through the normal retry/exhaustion/refund path rather than
 * some special case — an unknown jobType won't magically start working on
 * retry #2, so it'll just burn through maxAttempts and refund).
 */
export function defineWorker(module: string, handlers: JobHandlerMap): Worker {
  return new Worker(
    module,
    async (bullJob: BullJob) => {
      const attemptNumber = bullJob.attemptsMade + 1;

      const dbJob = await prisma.job.findUniqueOrThrow({ where: { id: bullJob.id } });

      await prisma.job.update({
        where: { id: dbJob.id },
        data: {
          status: "PROCESSING",
          attempts: attemptNumber,
          startedAt: dbJob.startedAt ?? new Date(),
        },
      });

      const jobRecord: JobRecord = {
        id: dbJob.id,
        creditAccountId: dbJob.creditAccountId!,
        creditsReserved: dbJob.creditsReserved,
        maxAttempts: dbJob.maxAttempts,
      };

      const handler = handlers[dbJob.jobType];

      try {
        if (!handler) {
          throw new UnknownJobTypeError(dbJob.module, dbJob.jobType);
        }

        const result = await handler({
          jobId: dbJob.id,
          attempt: attemptNumber,
          payload: (bullJob.data as { payload: Record<string, unknown> }).payload,
        });

        await handleAttemptOutcome(
          jobRecord,
          attemptNumber,
          { success: true, result },
          realActions,
        );

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await handleAttemptOutcome(
          jobRecord,
          attemptNumber,
          { success: false, error: message },
          realActions,
        );

        // Always rethrow on failure: BullMQ's own attempt counter and
        // failed-job bookkeeping need to see it too, even though our DB
        // (Job/JobAttempt/credit ledger) is already the source of truth.
        throw err;
      }
    },
    { connection: getRedisConnection() },
  );
}
