import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authorizedAgent } from "@/lib/services/authz";
import { confirmErc8004, erc8004View } from "@/lib/services/erc8004";

type P = { id: string };

/**
 * SDK: the agent's ERC-8004 registration. Fuku prepares the owner-wallet transactions (register,
 * then setAgentWallet signed by the agent's own key) and confirms mined ones; it never signs for the
 * owner. Caller: the owner, or an identity with an agents:manage delegation.
 */
const body = z.object({
  op: z.enum(["erc8004Register", "erc8004SetAgentWallet"]),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  const { agent } = await authorizedAgent(caller, id, "agents:manage");
  const [row, owner] = await Promise.all([db.agent.findUniqueOrThrow({ where: { id: agent.id } }), db.identity.findUniqueOrThrow({ where: { id: agent.identityId } })]);
  return json(await erc8004View(row, owner));
});

export const POST = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("manage", caller.id);
  const { agent } = await authorizedAgent(caller, id, "agents:manage");
  const input = body.parse(await req.json());
  const [row, owner] = await Promise.all([db.agent.findUniqueOrThrow({ where: { id: agent.id } }), db.identity.findUniqueOrThrow({ where: { id: agent.identityId } })]);
  const result = await confirmErc8004(row, owner, { op: input.op, txHash: input.txHash as `0x${string}` });
  return json(result, { status: result.ok ? 200 : 409 });
});
