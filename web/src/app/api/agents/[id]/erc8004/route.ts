import { z } from "zod";
import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { confirmErc8004, erc8004View, registerFromDemoWallet } from "@/lib/services/erc8004";

type P = { id: string };

/**
 * The agent's registration on the canonical ERC-8004 Identity Registry, for its signed-in owner.
 *   GET  -> status, and the transactions the owner's wallet still has to send
 *   POST { op, txHash }       -> confirm one after it was mined (receipt, sender, event, read)
 *   POST { demoWallet: true } -> seeded demo only: Fuku sends them from Ava's custodial wallet
 */
const body = z.union([
  z.object({ op: z.enum(["erc8004Register", "erc8004SetAgentWallet"]), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
  z.object({ demoWallet: z.literal(true) }),
]);

export const GET = withSession<P>(async (_req, identity, { id }) => {
  rateLimit("read", identity.id);
  const agent = await db.agent.findFirst({ where: { id, identityId: identity.id } });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  return json(await erc8004View(agent, identity));
});

export const POST = withSession<P>(async (req, identity, { id }) => {
  rateLimit("manage", identity.id);
  const agent = await db.agent.findFirst({ where: { id, identityId: identity.id } });
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  const input = body.parse(await req.json());
  if ("demoWallet" in input) return json(await registerFromDemoWallet(agent.id));
  const result = await confirmErc8004(agent, identity, { op: input.op, txHash: input.txHash as `0x${string}` });
  return json(result, { status: result.ok ? 200 : 409 });
});
