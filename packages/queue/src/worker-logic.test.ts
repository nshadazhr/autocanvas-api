import { describe, it, expect, beforeEach } from "vitest";
import { handleAttemptOutcome, type JobRecord, type WorkerActions } from "./worker-logic";

// A fake WorkerActions that just records every call it receives, in order,
// so tests can assert both *what* happened and *that nothing extra happened*
// (e.g. a retrying attempt must never also refund).
class RecordingActions implements WorkerActions {
  calls: string[] = [];

  async recordAttemptResult(jobId: string, attemptNumber: number, outcome: Parameters<WorkerActions["recordAttemptResult"]>[2]) {
    this.calls.push(`recordAttemptResult(${jobId},${attemptNumber},${outcome.success})`);
  }
  async markJobCompleted(jobId: string, creditsConsumed: number) {
    this.calls.push(`markJobCompleted(${jobId},${creditsConsumed})`);
  }
  async markJobRetrying(jobId: string, error: string) {
    this.calls.push(`markJobRetrying(${jobId},${error})`);
  }
  async markJobFailed(jobId: string, error: string) {
    this.calls.push(`markJobFailed(${jobId},${error})`);
  }
  async consumeCredits(accountId: string, amount: number, referenceId: string) {
    this.calls.push(`consumeCredits(${accountId},${amount},${referenceId})`);
  }
  async refundCredits(accountId: string, amount: number, referenceId: string) {
    this.calls.push(`refundCredits(${accountId},${amount},${referenceId})`);
  }
}

const job: JobRecord = {
  id: "job_1",
  creditAccountId: "acct_1",
  creditsReserved: 50,
  maxAttempts: 3,
};

let actions: RecordingActions;

beforeEach(() => {
  actions = new RecordingActions();
});

describe("handleAttemptOutcome — success", () => {
  it("consumes credits and marks the job completed, never touches retry/refund paths", async () => {
    const decision = await handleAttemptOutcome(
      job,
      1,
      { success: true, result: { ok: true } },
      actions,
    );

    expect(decision).toEqual({ shouldRethrow: false, action: "consumed" });
    expect(actions.calls).toEqual([
      "recordAttemptResult(job_1,1,true)",
      "consumeCredits(acct_1,50,job_1)",
      "markJobCompleted(job_1,50)",
    ]);
  });
});

describe("handleAttemptOutcome — failure with attempts remaining", () => {
  it("marks retrying and leaves the credit reservation untouched", async () => {
    const decision = await handleAttemptOutcome(
      job, // maxAttempts = 3
      1,
      { success: false, error: "boom" },
      actions,
    );

    expect(decision).toEqual({ shouldRethrow: true, action: "retrying" });
    expect(actions.calls).toEqual([
      "recordAttemptResult(job_1,1,false)",
      "markJobRetrying(job_1,boom)",
    ]);
    // Explicitly must NOT have consumed or refunded anything mid-retry.
    expect(actions.calls.some((c) => c.startsWith("consumeCredits"))).toBe(false);
    expect(actions.calls.some((c) => c.startsWith("refundCredits"))).toBe(false);
  });

  it("still retries on the second-to-last attempt (attempt 2 of 3)", async () => {
    const decision = await handleAttemptOutcome(
      job,
      2,
      { success: false, error: "still failing" },
      actions,
    );
    expect(decision.action).toBe("retrying");
  });
});

describe("handleAttemptOutcome — failure with attempts exhausted", () => {
  it("refunds credits and marks the job failed once attemptNumber reaches maxAttempts", async () => {
    const decision = await handleAttemptOutcome(
      job, // maxAttempts = 3
      3,
      { success: false, error: "final failure" },
      actions,
    );

    expect(decision).toEqual({ shouldRethrow: true, action: "refunded" });
    expect(actions.calls).toEqual([
      "recordAttemptResult(job_1,3,false)",
      "refundCredits(acct_1,50,job_1)",
      "markJobFailed(job_1,final failure)",
    ]);
    expect(actions.calls.some((c) => c.startsWith("consumeCredits"))).toBe(false);
    expect(actions.calls.some((c) => c.startsWith("markJobRetrying"))).toBe(false);
  });

  it("also treats attemptNumber beyond maxAttempts as exhausted (defensive, shouldn't normally happen)", async () => {
    const decision = await handleAttemptOutcome(
      job,
      99,
      { success: false, error: "should never get this far" },
      actions,
    );
    expect(decision.action).toBe("refunded");
  });

  it("respects a job-specific maxAttempts of 1 (no retries at all)", async () => {
    const oneShotJob: JobRecord = { ...job, maxAttempts: 1 };
    const decision = await handleAttemptOutcome(
      oneShotJob,
      1,
      { success: false, error: "no retries for you" },
      actions,
    );
    expect(decision.action).toBe("refunded");
  });
});
