import { db } from "../db";
import { utcDayKey, utcDayStart } from "../engine/permission";

/**
 * Authoritative off-chain spend per (agent, action, UTC day), in 6-decimal base units.
 *
 * The engine's R5 check reads the window; an allowed value action then reserves its amount with
 * one conditional UPDATE (`spent + amount <= limit`), which the database applies atomically, so two
 * concurrent requests can never both spend the same remainder. A reservation is released when the
 * execution fails or the on-chain guard rejects it. For A-Token transfers FukuSpendGuard enforces
 * its own on-chain cap as well; this window covers every value action, including the ones Fuku
 * only authorizes.
 */
const ZERO = BigInt(0);
const windowId = (agentId: string, action: string, day: string) => `${agentId}:${action}:${day}`;

/** Today's spend for (agent, action), creating the window from the ledger the first time. */
export async function spentMicros(agentId: string, action: string, now = new Date()): Promise<bigint> {
  const day = utcDayKey(now);
  const id = windowId(agentId, action, day);
  const row = await db.budgetWindow.findUnique({ where: { id } });
  if (row) return row.spentMicros;
  const initial = await ledgerSpend(agentId, action, now);
  try {
    await db.budgetWindow.create({ data: { id, agentId, action, day, spentMicros: initial } });
    return initial;
  } catch {
    // Created concurrently by another request: use theirs.
    const again = await db.budgetWindow.findUnique({ where: { id } });
    return again?.spentMicros ?? initial;
  }
}

/** Sum of today's allowed, not-failed actions (seeds a window created mid-day; covers legacy rows). */
async function ledgerSpend(agentId: string, action: string, now: Date): Promise<bigint> {
  const rows = await db.agentAction.findMany({
    where: {
      agentId,
      action,
      decision: "ALLOWED",
      createdAt: { gte: utcDayStart(now) },
      OR: [{ status: null }, { status: { notIn: ["FAILED", "DENIED"] } }],
    },
    select: { amountMicros: true, amountUsdc: true },
  });
  return rows.reduce((sum, r) => sum + (r.amountMicros ?? (r.amountUsdc ? BigInt(Math.round(r.amountUsdc * 1e6)) : ZERO)), ZERO);
}

/**
 * Reserve `amount` against `limit` for today. Returns ok=false (and the current spend) when the
 * reservation would exceed the limit; nothing is changed in that case.
 */
export async function reserveBudget(agentId: string, action: string, amount: bigint, limit: bigint, now = new Date()) {
  await spentMicros(agentId, action, now);
  const id = windowId(agentId, action, utcDayKey(now));
  const updated = await db.$executeRaw`UPDATE "BudgetWindow" SET "spentMicros" = "spentMicros" + ${amount} WHERE "id" = ${id} AND "spentMicros" + ${amount} <= ${limit}`;
  const row = await db.budgetWindow.findUnique({ where: { id } });
  return { ok: updated === 1, spent: row?.spentMicros ?? ZERO, day: utcDayKey(now) };
}

/** Give back a reservation made on `day` (YYYY-MM-DD), never below zero. Idempotency is the caller's job. */
export async function releaseBudget(agentId: string, action: string, amount: bigint, day: string) {
  const id = windowId(agentId, action, day);
  await db.$executeRaw`UPDATE "BudgetWindow" SET "spentMicros" = CASE WHEN "spentMicros" > ${amount} THEN "spentMicros" - ${amount} ELSE 0 END WHERE "id" = ${id}`;
}
