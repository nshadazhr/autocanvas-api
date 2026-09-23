import { prisma } from "@platform/database";
import { InsufficientCreditsError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────
// A NOTE ON WHAT CHANGED FROM THE ORIGINAL ARCHITECTURE SKETCH
//
// The architecture doc's reserve/consume/refund pseudocode had `balance`
// staying untouched during CONSUME ("insert credit_transactions(type=
// 'consume', amount=0)"). Followed literally, a user's `balance` would
// never actually decrease after a successful generation — only `reserved`
// would fluctuate up and down, so credits would never really get spent.
// That's a real double-accounting bug, not just a simplification, so this
// implementation fixes it here rather than carrying it into working code:
//
//   RESERVE  — checks (balance - reserved) >= amount, then reserved += amount.
//              `balance` is untouched (nothing has been spent yet — this is
//              an authorization hold, same idea as a card pre-auth). We
//              still write a ledger row (amount = 0) purely for audit
//              visibility ("credits X were held for job Y at time Z").
//   CONSUME  — on job success: balance -= amount AND reserved -= amount.
//              This is the actual spend. Ledger row amount = -amount.
//   REFUND   — on job failure/cancel: reserved -= amount only. `balance`
//              is untouched because it was never decremented at reserve
//              time — releasing the hold is enough to make the credits
//              spendable again. Ledger row amount = 0 (nothing was really
//              refunded because nothing was really spent), but the row
//              still exists so admins can see a hold was released and why.
//   GRANT / PURCHASE / ADJUSTMENT — the only operations that actually move
//              `balance` outside of CONSUME: signup bonus, a paid top-up,
//              or a manual admin correction. Ledger row amount = ±amount.
//
// `available to spend` is always computed as `balance - reserved`, never
// stored directly.
// ─────────────────────────────────────────────────────────────────────────

/** Kept as a plain literal union (not imported from the generated Prisma
 * client) so this package's public types don't depend on `prisma generate`
 * having been run — see the network-restriction note in the repo README. */
export type LedgerReferenceType = "job" | "subscription_plan" | "payment" | "admin_action";

export interface CreditSnapshot {
  balance: bigint;
  reserved: bigint;
  available: bigint;
}

// Minimal structural subset of PrismaClient this module actually calls —
// lets tests inject an in-memory fake instead of a real Postgres instance.
// Any real PrismaClient / transaction client satisfies this automatically.
export interface LedgerTxClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  creditAccount: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<{
      id: string;
      balance: bigint;
      reserved: bigint;
    }>;
    update(args: {
      where: { id: string };
      data: { balance?: bigint; reserved?: bigint };
    }): Promise<unknown>;
  };
  creditTransaction: {
    create(args: {
      data: {
        creditAccountId: string;
        type: string;
        amount: bigint;
        referenceType?: LedgerReferenceType;
        referenceId?: string;
        balanceAfter: bigint;
      };
    }): Promise<unknown>;
  };
}

export interface LedgerDbClient {
  $transaction<T>(fn: (tx: LedgerTxClient) => Promise<T>): Promise<T>;
}

interface MutateOptions {
  referenceType?: LedgerReferenceType;
  referenceId?: string;
  db?: LedgerDbClient;
}

async function lockAndLoadAccount(tx: LedgerTxClient, accountId: string) {
  // The SELECT ... FOR UPDATE acquires a row-level lock inside the current
  // transaction; any concurrent transaction trying to reserve/consume/
  // refund against the same account blocks here until this one commits or
  // rolls back. This is what actually prevents the double-spend race
  // (two "generate all scenes" clicks landing at the same instant), not
  // just the balance check by itself.
  await tx.$executeRaw`SELECT id FROM credit_accounts WHERE id = ${accountId} FOR UPDATE`;
  return tx.creditAccount.findUniqueOrThrow({ where: { id: accountId } });
}

export function toSnapshot(account: { balance: bigint; reserved: bigint }): CreditSnapshot {
  return {
    balance: account.balance,
    reserved: account.reserved,
    available: account.balance - account.reserved,
  };
}

/** Places a hold for `amount` credits. Throws InsufficientCreditsError if
 * (balance - reserved) can't cover it. Call before enqueueing a job. */
export async function reserveCredits(
  accountId: string,
  amount: bigint,
  opts: MutateOptions = {},
): Promise<CreditSnapshot> {
  const db = opts.db ?? (prisma as unknown as LedgerDbClient);
  return db.$transaction(async (tx) => {
    const account = await lockAndLoadAccount(tx, accountId);
    const available = account.balance - account.reserved;
    if (available < amount) {
      throw new InsufficientCreditsError(accountId, amount, available);
    }

    const newReserved = account.reserved + amount;
    await tx.creditAccount.update({
      where: { id: accountId },
      data: { reserved: newReserved },
    });
    await tx.creditTransaction.create({
      data: {
        creditAccountId: accountId,
        type: "RESERVE",
        amount: 0n,
        referenceType: opts.referenceType ?? "job",
        referenceId: opts.referenceId,
        balanceAfter: account.balance,
      },
    });

    return toSnapshot({ balance: account.balance, reserved: newReserved });
  });
}

/** Finalizes a spend on job success: moves the held amount from "reserved"
 * into an actual balance deduction. Call from the worker on job completion. */
export async function consumeCredits(
  accountId: string,
  amount: bigint,
  opts: MutateOptions = {},
): Promise<CreditSnapshot> {
  const db = opts.db ?? (prisma as unknown as LedgerDbClient);
  return db.$transaction(async (tx) => {
    const account = await lockAndLoadAccount(tx, accountId);
    if (account.reserved < amount) {
      // Defensive: this indicates a caller bug (consuming more than was
      // reserved), not a normal user-facing insufficient-funds case.
      throw new Error(
        `consumeCredits: account ${accountId} only has ${account.reserved} reserved, cannot consume ${amount}.`,
      );
    }

    const newBalance = account.balance - amount;
    const newReserved = account.reserved - amount;
    await tx.creditAccount.update({
      where: { id: accountId },
      data: { balance: newBalance, reserved: newReserved },
    });
    await tx.creditTransaction.create({
      data: {
        creditAccountId: accountId,
        type: "CONSUME",
        amount: -amount,
        referenceType: opts.referenceType ?? "job",
        referenceId: opts.referenceId,
        balanceAfter: newBalance,
      },
    });

    return toSnapshot({ balance: newBalance, reserved: newReserved });
  });
}

/** Releases a hold on job failure/cancellation/max-retries-exhausted.
 * Balance is untouched — nothing was actually spent. */
export async function refundCredits(
  accountId: string,
  amount: bigint,
  opts: MutateOptions = {},
): Promise<CreditSnapshot> {
  const db = opts.db ?? (prisma as unknown as LedgerDbClient);
  return db.$transaction(async (tx) => {
    const account = await lockAndLoadAccount(tx, accountId);
    const newReserved = account.reserved - amount;
    if (newReserved < 0n) {
      throw new Error(
        `refundCredits: account ${accountId} only has ${account.reserved} reserved, cannot release ${amount}.`,
      );
    }

    await tx.creditAccount.update({
      where: { id: accountId },
      data: { reserved: newReserved },
    });
    await tx.creditTransaction.create({
      data: {
        creditAccountId: accountId,
        type: "REFUND",
        amount: 0n,
        referenceType: opts.referenceType ?? "job",
        referenceId: opts.referenceId,
        balanceAfter: account.balance,
      },
    });

    return toSnapshot({ balance: account.balance, reserved: newReserved });
  });
}

/** The only path (besides admin ADJUSTMENT) that actually adds credits to
 * `balance` — signup bonus, monthly plan renewal, a paid top-up. */
export async function grantCredits(
  accountId: string,
  amount: bigint,
  opts: MutateOptions & { type?: "GRANT" | "PURCHASE" | "ADJUSTMENT" } = {},
): Promise<CreditSnapshot> {
  const db = opts.db ?? (prisma as unknown as LedgerDbClient);
  return db.$transaction(async (tx) => {
    const account = await lockAndLoadAccount(tx, accountId);
    const newBalance = account.balance + amount;

    await tx.creditAccount.update({
      where: { id: accountId },
      data: { balance: newBalance },
    });
    await tx.creditTransaction.create({
      data: {
        creditAccountId: accountId,
        type: opts.type ?? "GRANT",
        amount,
        referenceType: opts.referenceType,
        referenceId: opts.referenceId,
        balanceAfter: newBalance,
      },
    });

    return toSnapshot({ balance: newBalance, reserved: account.reserved });
  });
}

export async function getSnapshot(
  accountId: string,
  db: LedgerDbClient = prisma as unknown as LedgerDbClient,
): Promise<CreditSnapshot> {
  return db.$transaction(async (tx) => {
    const account = await tx.creditAccount.findUniqueOrThrow({ where: { id: accountId } });
    return toSnapshot(account);
  });
}
