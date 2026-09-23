import { describe, it, expect, vi, beforeEach } from "vitest";

// `retry.ts` only needs `prisma.job.findUnique` from @platform/database and
// delegates all the real reserve/push work to `enqueueJob` (already covered
// by its own reasoning in enqueue.ts) — so this test mocks both boundaries
// and asserts `retryFailedJob`'s own decision logic in isolation: which
// jobs it accepts, which it rejects, and exactly what it hands to
// `enqueueJob` when it does proceed.
const findUnique = vi.fn();
vi.mock("@platform/database", () => ({
  prisma: { job: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

const enqueueJob = vi.fn();
vi.mock("./enqueue", () => ({
  enqueueJob: (...args: unknown[]) => enqueueJob(...args),
}));

const { retryFailedJob, JobNotFailedError, JobMissingCreditAccountError } = await import("./retry");
const { JobNotFoundError } = await import("./errors");

const baseFailedJob = {
  id: "job_1",
  userId: "user_1",
  projectId: "project_1",
  creditAccountId: "acct_1",
  module: "audio",
  jobType: "generate_scene_audio",
  status: "FAILED",
  payload: { sceneId: "scene_1" },
  provider: "mock_audio",
  model: "mock_v1",
  creditsReserved: 12,
  maxAttempts: 3,
};

beforeEach(() => {
  findUnique.mockReset();
  enqueueJob.mockReset();
});

describe("retryFailedJob", () => {
  it("throws JobNotFoundError when the job doesn't exist", async () => {
    findUnique.mockResolvedValue(null);
    await expect(retryFailedJob("missing")).rejects.toBeInstanceOf(JobNotFoundError);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("throws JobNotFailedError for a job that isn't FAILED (e.g. still QUEUED or already COMPLETED)", async () => {
    findUnique.mockResolvedValue({ ...baseFailedJob, status: "COMPLETED" });
    await expect(retryFailedJob("job_1")).rejects.toBeInstanceOf(JobNotFailedError);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("throws JobMissingCreditAccountError when creditAccountId is null", async () => {
    findUnique.mockResolvedValue({ ...baseFailedJob, creditAccountId: null });
    await expect(retryFailedJob("job_1")).rejects.toBeInstanceOf(JobMissingCreditAccountError);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("re-enqueues a FAILED job with the same module/jobType/payload/credits, creating a new attempt rather than mutating the old row", async () => {
    findUnique.mockResolvedValue(baseFailedJob);
    enqueueJob.mockResolvedValue({ jobId: "job_2" });

    const result = await retryFailedJob("job_1");

    expect(result).toEqual({ jobId: "job_2" });
    expect(enqueueJob).toHaveBeenCalledWith({
      userId: "user_1",
      projectId: "project_1",
      creditAccountId: "acct_1",
      module: "audio",
      jobType: "generate_scene_audio",
      payload: { sceneId: "scene_1" },
      creditsToReserve: 12,
      provider: "mock_audio",
      model: "mock_v1",
      maxAttempts: 3,
    });
  });

  it("passes projectId/provider/model through as undefined rather than null when the original job has none", async () => {
    findUnique.mockResolvedValue({
      ...baseFailedJob,
      projectId: null,
      provider: null,
      model: null,
    });
    enqueueJob.mockResolvedValue({ jobId: "job_3" });

    await retryFailedJob("job_1");

    expect(enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined, provider: undefined, model: undefined }),
    );
  });
});
