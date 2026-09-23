import { describe, it, expect, beforeEach } from "vitest";
import {
  reserveCredits,
  consumeCredits,
  refundCredits,
  grantCredits,
  getSnapshot,
  type LedgerDbClient,
  type LedgerTxClient,
} from "./ledger";
import { InsufficientCreditsError } from "./errors";

// ───────────────────────────────────────────────────────────────────────────
// Why a hand-rolled mock instead of a real Postgres instance
//
// This sandbox has no Docker/Postgres available, so we can't spin up a real
// database to prove the `SELECT ... FOR UPDATE` locking actually prevents a
// double-spend under real concurrent connections. What we CAN verify here is
// the business logic (arithmetic, error conditions) plus a faithful
// *simulation* of the locking behavior: this mock only releases an account's
// lock when the surrounding `$transaction` callback resolves (mirroring
// "the lock is held until COMMIT/ROLLBACK, not until the SELECT returns"),
// and queues concurrent callers on the same account FIFO. That's enough to
// reproduce the double-spend race in-process and prove `reserveCredits`
// rejects the second caller once funds are exhausted.
//
// This does NOT replace real integration testing against Postgres — anyone
// picking this up should also run a concurrency test with `docker compose up`
// against the real schema before relying on this in production.
// ───────────────────────────────────────────────────────────────────────────

interface MockAccount {
  id: string;
  balance: bigint;
  reserved: bigint;
}

class MockLedgerDb implements LedgerDbClient {
  accounts: Map<string, MockAccount>;
  ledgerRows: Array<Record<string, unknown>> = [];
  private locks = new Map<string, Promise<void>>();

  constructor(seed: MockAccount[]) {
    this.accounts = new Map(seed.map((a) => [a.id, { ...a }]));
  }

  async $transaction<T>(fn: (tx: LedgerTxClient) => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;

    const tx: LedgerTxClient = {
      $executeRaw: async (_query, ...values) => {
        const accountId = values[0] as string;
        const priorLock = this.locks.get(accountId) ?? Promise.resolve();
        let releaseThis!: () => void;
        const thisLock = new Promise<void>((resolve) => {
          releaseThis = resolve;
        });
        // Whoever asks for the lock next must wait for us too, not just
        // whoever was ahead of us — this is what makes it FIFO per account.
        this.locks.set(
          accountId,
          priorLock.then(() => thisLock),
        );
        await priorLock; // wait for our turn
        release = releaseThis; // released in the $transaction `finally` below
        return 1;
      },
      creditAccount: {
        findUniqueOrThrow: async ({ where: { id } }) => {
          const acct = this.accounts.get(id);
          if (!acct) throw new Error(`MockLedgerDb: no account ${id}`);
          return { ...acct };
        },
        update: async ({ where: { id }, data }) => {
          const acct = this.accounts.get(id);
          if (!acct) throw new Error(`MockLedgerDb: no account ${id}`);
          if (data.balance !== undefined) acct.balance = data.balance;
          if (data.reserved !== undefined) acct.reserved = data.reserved;
          return acct;
        },
      },
      creditTransaction: {
        create: async ({ data }) => {
          this.ledgerRows.push(data);
          return data;
        },
      },
    };

    try {
      return await fn(tx);
    } finally {
      // Simulates the lock releasing at COMMIT/ROLLBACK — i.e. only once the
      // whole logical transaction (not just the SELECT) is done.
      release?.();
    }
  }
}

const ACCOUNT_ID = "acct_1";

function freshDb(balance: bigint, reserved = 0n) {
  return new MockLedgerDb([{ id: ACCOUNT_ID, balance, reserved }]);
}

describe("reserveCredits", () => {
  it("increments reserved and leaves balance untouched", async () => {
    const db = freshDb(100n);
    const snapshot = await reserveCredits(ACCOUNT_ID, 30n, { db });
    expect(snapshot.balance).toBe(100n);
    expect(snapshot.reserved).toBe(30n);
    expect(snapshot.available).toBe(70n);

    const row = db.ledgerRows.at(-1)!;
    expect(row.type).toBe("RESERVE");
    expect(row.amount).toBe(0n);
  });

  it("throws InsufficientCreditsError when available < amount", async () => {
    const db = freshDb(50n, 40n); // available = 10
    await expect(reserveCredits(ACCOUNT_ID, 20n, { db })).rejects.toThrow(
      InsufficientCreditsError,
    );
    // Nothing should have moved.
    const snapshot = await getSnapshot(ACCOUNT_ID, db);
    expect(snapshot.reserved).toBe(40n);
  });

  it("never lets two concurrent reserves double-spend the same balance", async () => {
    // Balance 100, two concurrent requests for 60 each. Only one can win —
    // the other must see the post-lock state and get rejected.
    const db = freshDb(100n);

    const results = await Promise.allSettled([
      reserveCredits(ACCOUNT_ID, 60n, { db }),
      reserveCredits(ACCOUNT_ID, 60n, { db }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InsufficientCreditsError,
    );

    const finalAccount = db.accounts.get(ACCOUNT_ID)!;
    expect(finalAccount.reserved).toBe(60n); // not 120n
    expect(finalAccount.balance).toBe(100n);
  });
});

describe("consumeCredits", () => {
  it("decrements both balance and reserved on success", async () => {
    const db = freshDb(100n, 30n);
    const snapshot = await consumeCredits(ACCOUNT_ID, 30n, { db });
    expect(snapshot.balance).toBe(70n);
    expect(snapshot.reserved).toBe(0n);
    expect(snapshot.available).toBe(70n);

    const row = db.ledgerRows.at(-1)!;
    expect(row.type).toBe("CONSUME");
    expect(row.amount).toBe(-30n);
  });

  it("throws if consuming more than what's reserved", async () => {
    const db = freshDb(100n, 10n);
    await expect(consumeCredits(ACCOUNT_ID, 30n, { db })).rejects.toThrow(
      /only has 10 reserved/,
    );
  });
});

describe("refundCredits", () => {
  it("releases the hold without touching balance", async () => {
    const db = freshDb(100n, 30n);
    const snapshot = await refundCredits(ACCOUNT_ID, 30n, { db });
    expect(snapshot.balance).toBe(100n);
    expect(snapshot.reserved).toBe(0n);

    const row = db.ledgerRows.at(-1)!;
    expect(row.type).toBe("REFUND");
    expect(row.amount).toBe(0n);
  });

  it("throws if releasing more than what's reserved", async () => {
    const db = freshDb(100n, 10n);
    await expect(refundCredits(ACCOUNT_ID, 30n, { db })).rejects.toThrow(
      /only has 10 reserved/,
    );
  });
});

describe("grantCredits", () => {
  it("increases balance and leaves reserved untouched", async () => {
    const db = freshDb(100n, 20n);
    const snapshot = await grantCredits(ACCOUNT_ID, 50n, { db, type: "PURCHASE" });
    expect(snapshot.balance).toBe(150n);
    expect(snapshot.reserved).toBe(20n);
    expect(snapshot.available).toBe(130n);

    const row = db.ledgerRows.at(-1)!;
    expect(row.type).toBe("PURCHASE");
    expect(row.amount).toBe(50n);
  });

  it("defaults to type GRANT when not specified", async () => {
    const db = freshDb(0n);
    await grantCredits(ACCOUNT_ID, 500n, { db, referenceType: "subscription_plan" });
    const row = db.ledgerRows.at(-1)!;
    expect(row.type).toBe("GRANT");
  });
});

describe("full reserve -> consume lifecycle", () => {
  it("matches the corrected semantics end to end", async () => {
    const db = freshDb(100n);

    let snapshot = await reserveCredits(ACCOUNT_ID, 40n, { db });
    expect(snapshot).toEqual({ balance: 100n, reserved: 40n, available: 60n });

    snapshot = await consumeCredits(ACCOUNT_ID, 40n, { db });
    expect(snapshot).toEqual({ balance: 60n, reserved: 0n, available: 60n });

    expect(db.ledgerRows.map((r) => r.type)).toEqual(["RESERVE", "CONSUME"]);
  });

  it("matches the corrected semantics for a failed job (reserve -> refund)", async () => {
    const db = freshDb(100n);

    await reserveCredits(ACCOUNT_ID, 40n, { db });
    const snapshot = await refundCredits(ACCOUNT_ID, 40n, { db });

    // Balance was never touched at any point — the whole point of the fix.
    expect(snapshot).toEqual({ balance: 100n, reserved: 0n, available: 100n });
  });
});

describe("getSnapshot", () => {
  it("computes available as balance - reserved", async () => {
    const db = freshDb(80n, 25n);
    const snapshot = await getSnapshot(ACCOUNT_ID, db);
    expect(snapshot).toEqual({ balance: 80n, reserved: 25n, available: 55n });
  });
});
