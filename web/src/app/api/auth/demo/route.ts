import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { createSession } from "@/lib/session";
import { DEMO_IDENTITY_ID, activeDemoAgentIds, seedDemo } from "@/lib/demo-seed";
import { setAgentStatusOnChain, toAgentRef } from "@/lib/chain";
import { demoEnabled, demoResetAllowed, safeNextPath } from "@/lib/demo-mode";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/**
 * A reset re-seeds the Payments Agent as active, but an earlier kill switch may have left it
 * paused in AgentRegistry, where FukuSpendGuard would keep rejecting it (R10 AgentNotActive).
 * Bring the registry back in line with the fresh seed; a failure only means the drift remains.
 */
async function resyncPaymentsAgent() {
  const { payments } = await activeDemoAgentIds(db);
  const agent = await db.agent.findUnique({ where: { id: payments }, include: { policy: true, identity: true } });
  if (!agent || agent.status !== "active") return;
  try {
    await setAgentStatusOnChain(toAgentRef(agent, agent.identity), "active");
  } catch (err) {
    console.warn(`[fuku-demo] could not resume ${payments} on-chain after reset: ${(err as Error).message}`);
  }
}

async function signInDemo(reset: boolean) {
  const existing = await db.identity.findUnique({ where: { id: DEMO_IDENTITY_ID } });
  if (!existing || reset) {
    await seedDemo(db);
    await resyncPaymentsAgent();
  }
  await createSession(DEMO_IDENTITY_ID);
  return { identity: await db.identity.findUniqueOrThrow({ where: { id: DEMO_IDENTITY_ID } }), reseeded: !existing || reset };
}

const DISABLED = { error: "The demo sign-in is disabled on this deployment.", code: "demo_disabled" };

/**
 * Signs in as the seeded demo identity (Ava Chen); re-seeds it when missing or when ?reset=1
 * (plus &token=FUKU_DEMO_RESET_TOKEN when that is set).
 * Off in production unless FUKU_DEMO_ENABLED=true (see lib/demo-mode.ts).
 */
export const POST = withErrors(async (req) => {
  if (!demoEnabled()) return json(DISABLED, { status: 404 });
  rateLimit("auth", clientIp(req));
  const params = new URL(req.url).searchParams;
  const reset = params.get("reset") === "1" && demoResetAllowed(params.get("token"));
  return json(await signInDemo(reset));
});

/** GET /api/auth/demo?next=/dashboard — one-link demo entry: sign in and redirect (same-site paths only). */
export const GET = withErrors(async (req) => {
  if (!demoEnabled()) return json(DISABLED, { status: 404 });
  rateLimit("auth", clientIp(req));
  const url = new URL(req.url);
  const reset = url.searchParams.get("reset") === "1" && demoResetAllowed(url.searchParams.get("token"));
  await signInDemo(reset);
  return NextResponse.redirect(new URL(safeNextPath(url.searchParams.get("next")), url.origin));
});
