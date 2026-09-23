// ─────────────────────────────────────────────────────────────────────────
// Pure decision logic for "what happens after one job attempt finishes."
//
// This file deliberately has NO import of bullmq, ioredis, or the real
// Prisma client. It takes a plain description of the job + the outcome of
// the attempt, and a `WorkerActions` port (a small set of async callbacks),
// and decides which actions to call in which order. `worker.ts` wires the
// real BullMQ/Prisma/@platform/credits calls into that port; tests
// (worker-logic.test.ts) wire a fake recorder into it instead.
//
// Why this split exists: BullMQ needs a real Redis server to run at all
// (confirmed in this sandbox — even `ioredis-mock` can't run BullMQ's Lua
// scripts, they use a `cmsgpack` Lua library the mock doesn't implement).
// So the actual queue<->worker wiring can't be exercised end-to-end here.
// But the part that actually matters for correctness — "after N failures,
// stop retrying and refund; after success, consume; never do both, never
// do neither" — has nothing to do with Redis. Pulling it out into a pure
// function means that logic gets real, running unit test coverage instead
// of just being eyeballed.
// ─────────────────────────────────────────────────────────────────────────

export interface JobRecord {
  id: string;
  creditAccountId: string;
  creditsReserved: number;
  maxAttempts: number;
}

export type AttemptOutcome =
  | { success: true; result: unknown }
  | { success: false; error: string };

export interface WorkerActions {
  recordAttemptResult(
    jobId: string,
    attemptNumber: number,
    outcome: AttemptOutcome,
  ): Promise<void>;
  /** Job succeeded outright: spend the reservation for real. */
  markJobCompleted(jobId: string, creditsConsumed: number): Promise<void>;
  /** Job failed but attempts remain: leave the reservation in place, BullMQ will retry with backoff. */
  markJobRetrying(jobId: string, error: string): Promise<void>;
  /** Job failed and attempts are exhausted: give the credits back. */
  markJobFailed(jobId: string, error: string): Promise<void>;
  consumeCredits(accountId: string, amount: number, referenceId: string): Promise<void>;
  refundCredits(accountId: string, amount: number, referenceId: string): Promise<void>;
}

export interface AttemptDecision {
  /**
   * Whether the caller (worker.ts) should re-throw the original error so
   * BullMQ's own retry/backoff and failed-job bookkeeping kicks in. Always
   * true on failure (whether or not attempts remain) — false only on
   * success.
   */
  shouldRethrow: boolean;
  /** What we decided to do, mainly here so tests can assert on it directly. */
  action: "consumed" | "retrying" | "refunded";
}

/**
 * Called exactly once per BullMQ attempt, after the handler has either
 * resolved or thrown. `attemptNumber` is 1-indexed (first try = 1).
 */
export async function handleAttemptOutcome(
  job: JobRecord,
  attemptNumber: number,
  outcome: AttemptOutcome,
  actions: WorkerActions,
): Promise<AttemptDecision> {
  await actions.recordAttemptResult(job.id, attemptNumber, outcome);

  if (outcome.success) {
    await actions.consumeCredits(job.creditAccountId, job.creditsReserved, job.id);
    await actions.markJobCompleted(job.id, job.creditsReserved);
    return { shouldRethrow: false, action: "consumed" };
  }

  const attemptsExhausted = attemptNumber >= job.maxAttempts;

  if (!attemptsExhausted) {
    await actions.markJobRetrying(job.id, outcome.error);
    return { shouldRethrow: true, action: "retrying" };
  }

  await actions.refundCredits(job.creditAccountId, job.creditsReserved, job.id);
  await actions.markJobFailed(job.id, outcome.error);
  return { shouldRethrow: true, action: "refunded" };
}
