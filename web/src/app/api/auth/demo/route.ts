import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { createSession } from "@/lib/session";
import { DEMO_IDENTITY_ID, PAYMENTS_AGENT_ID, seedDemo } from "@/lib/demo-seed";
import { setAgentStatusOnChain, toAgentRef } from "@/lib/chain";

/**
 * A reset re-seeds the Payments Agent as active, but an earlier kill switch may have left it
 * paused in AgentRegistry, where FukuSpendGuard would keep rejecting it (R10 AgentNotActive).
 * Bring the registry back in line with the fresh seed; a failure only means the drift remains.
 */
async function resyncPaymentsAgent() {
  const agent = await db.agent.findUnique({ where: { id: PAYMENTS_AGENT_ID }, include: { policy: true, identity: true } });
  if (!agent || agent.status !== "active") return;
  try {
    await setAgentStatusOnChain(toAgentRef(agent, agent.identity), "active");
  } catch (err) {
    console.warn(`[fuku-demo] could not resume ${PAYMENTS_AGENT_ID} on-chain after reset: ${(err as Error).message}`);
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

/** Signs in as the seeded demo identity (Ava Chen); re-seeds it when missing or when ?reset=1. */
export const POST = withErrors(async (req) => {
  const reset = new URL(req.url).searchParams.get("reset") === "1";
  return json(await signInDemo(reset));
});

/** GET /api/auth/demo?next=/dashboard — one-link demo entry: sign in and redirect. */
export const GET = withErrors(async (req) => {
  const url = new URL(req.url);
  const reset = url.searchParams.get("reset") === "1";
  const next = url.searchParams.get("next") ?? "/dashboard";
  await signInDemo(reset);
  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/dashboard", url.origin));
});
