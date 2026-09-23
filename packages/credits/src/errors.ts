export class InsufficientCreditsError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly requested: bigint,
    public readonly available: bigint,
  ) {
    super(
      `Insufficient credits on account ${accountId}: requested ${requested}, ` +
        `only ${available} available.`,
    );
    this.name = "InsufficientCreditsError";
  }
}

export class CreditAccountNotFoundError extends Error {
  constructor(public readonly accountId: string) {
    super(`Credit account ${accountId} does not exist.`);
    this.name = "CreditAccountNotFoundError";
  }
}
