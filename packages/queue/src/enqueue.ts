import { Queue } from "bullmq";
import { prisma } from "@platform/database";
import { reserveCredits, refundCredits } from "@platform/credits";
import { getRedisConnection } from "./connection";
import type { EnqueueJobInput, EnqueueJobResult } from "./types";

// One BullMQ Queue per `module` string, cached so repeated enqueueJob calls
// for the same module reuse the same connection/queue object instead of
// opening a new one every time.
const queues = new Map<string, Queue>();

function getQueueFor(module: string): Queue {
  let queue = queues.get(module);
  if (!queue) {
    queue = new Queue(module, { connection: getRedisConnection() });
    queues.set(module, queue);
  }
  return queue;
}

/**
 * Create the DB `Job` row, reserve credits against it, then push it onto
 * the BullMQ queue for `input.module` — in that order:
 *
 *  1. Job row created first (status QUEUED) so we have a real job id to use
 *     as the ledger transaction's `referenceId` — "reserved for job X" is
 *     traceable from day one, not backfilled after the fact.
 *  2. Credits reserved against `input.creditAccountId`, tagged with that
 *     job id. If this throws (InsufficientCreditsError), the Job row is
 *     kept but marked FAILED rather than deleted — it's a real audit trail
 *     of "user tried to queue this and didn't have the credits," which is
 *     useful in the admin panel (Chunk 8), not noise to clean up.
 *  3. Only once credits are actually reserved does the job get pushed onto
 *     BullMQ. If that push fails (e.g. Redis unreachable), the reservation
 *     is refunded before rethrowing — credits never get stuck reserved
 *     against a job no worker will ever see.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<EnqueueJobResult> {
  const maxAttempts = input.maxAttempts ?? 3;
  const creditsToReserve = BigInt(input.creditsToReserve);

  const job = await prisma.job.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      creditAccountId: input.creditAccountId,
      module: input.module,
      jobType: input.jobType,
      status: "QUEUED",
      maxAttempts,
      provider: input.provider,
      model: input.model,
      payload: input.payload,
      creditsReserved: input.creditsToReserve,
    },
  });

  try {
    await reserveCredits(input.creditAccountId, creditsToReserve, {
      referenceType: "job",
      referenceId: job.id,
    });
  } catch (err) {
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        error: err instanceof Error ? err.message : "Failed to reserve credits",
        finishedAt: new Date(),
      },
    });
    throw err;
  }

  try {
    const queue = getQueueFor(input.module);
    await queue.add(
      input.jobType,
      { payload: input.payload },
      {
        jobId: job.id, // BullMQ job id == our Job row id, so there's no separate mapping to maintain.
        attempts: maxAttempts,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 60 * 60 * 24 }, // keep 24h for debugging, then GC
        removeOnFail: false, // keep failed jobs around until someone looks at them (admin panel, Chunk 8)
      },
    );
  } catch (err) {
    await refundCredits(input.creditAccountId, creditsToReserve, {
      referenceType: "job",
      referenceId: job.id,
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        error: err instanceof Error ? err.message : "Failed to enqueue onto the job queue",
        finishedAt: new Date(),
      },
    });
    throw err;
  }

  return { jobId: job.id };
}
