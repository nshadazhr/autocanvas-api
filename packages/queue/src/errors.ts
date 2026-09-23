export class JobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

export class UnknownJobTypeError extends Error {
  constructor(public readonly module: string, public readonly jobType: string) {
    super(`No handler registered for module "${module}" jobType "${jobType}"`);
    this.name = "UnknownJobTypeError";
  }
}
