import type { NextRequest } from "next/server";

/**
 * Fixed-window request limits, kept in process memory. Bounded: at most MAX_KEYS windows are
 * tracked and expired ones are swept first. Limitation (documented in docs/SECURITY.md): limits are
 * per server process, so N instances allow N times the budget; a shared store (Redis, the database)
 * is the upgrade path for multi-instance deployments.
 */
export class RateLimitError extends Error {
  constructor(readonly retryAfterSec: number) {
    super("Too many requests. Slow down and retry shortly.");
    this.name = "RateLimitError";
  }
}

const MAX_KEYS = 10_000;
const g = globalThis as unknown as { __fukuRateLimits?: Map<string, { count: number; resetAt: number }> };
const windows = (g.__fukuRateLimits ??= new Map());

export const LIMITS = {
  /** Passkey, Dynamic and demo sign-in, per client IP. */
  auth: { limit: 20, windowMs: 60_000 },
  /** Identity and agent creation, per caller. */
  create: { limit: 20, windowMs: 60_000 },
  /** Passport, status, delegation and wallet changes, per caller. */
  manage: { limit: 30, windowMs: 60_000 },
  /** Action execution (may move tokens and write on-chain), per caller. */
  execute: { limit: 60, windowMs: 60_000 },
  /** Dry runs and provider reads, per caller. */
  read: { limit: 120, windowMs: 60_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

/** Count one request against `bucket` for `subject`; throws RateLimitError over the limit. */
export function rateLimit(bucket: LimitName, subject: string, now = Date.now()) {
  const { limit, windowMs } = LIMITS[bucket];
  const key = `${bucket}:${subject}`;
  let w = windows.get(key);
  if (!w || w.resetAt <= now) {
    if (windows.size >= MAX_KEYS) sweep(now);
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  w.count += 1;
  if (w.count > limit) throw new RateLimitError(Math.max(1, Math.ceil((w.resetAt - now) / 1000)));
}

function sweep(now: number) {
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  // Still full (a flood of distinct keys): drop the oldest half rather than grow without bound.
  if (windows.size >= MAX_KEYS) {
    let i = 0;
    for (const k of windows.keys()) {
      if (i++ >= MAX_KEYS / 2) break;
      windows.delete(k);
    }
  }
}

/** Client address for per-IP limits: the first X-Forwarded-For hop, else a constant for direct local calls. */
export function clientIp(req: NextRequest | Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64);
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? "direct";
}

/** Test hook. */
export function resetRateLimits() {
  windows.clear();
}
