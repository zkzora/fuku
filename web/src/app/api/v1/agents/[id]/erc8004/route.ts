import { z } from "zod";
import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { authorizedAgent } from "@/lib/services/authz";
import { confirmErc8004, erc8004View, prepareExternalAgentWallet, setExternalAgentKey } from "@/lib/services/erc8004";

type P = { id: string };

/**
 * SDK: the agent's ERC-8004 registration. Fuku prepares the owner-wallet transactions (register, then
 * setAgentWallet) and confirms mined ones; it never signs for the owner. The agent key is either the
 * developer's own (PUT its address; its AgentWalletSet signature is checked by POST) or, when none is
 * set, one Fuku generates and holds. Caller: the owner, or an identity with an agents:manage delegation.
 *   GET                                  -> status, owner actions, typed data for an external key
 *   PUT  { agentKey }                    -> the developer's agent key address
 *   POST { agentWalletSignature, deadline } -> the prepared setAgentWallet for the owner's wallet
 *   POST { op, txHash }                  -> confirm a mined owner transaction
 */
const keyBody = z.object({ agentKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
const postBody = z.union([
  z.object({ op: z.enum(["erc8004Register", "erc8004SetAgentWallet"]), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
  z.object({ agentWalletSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), deadline: z.string().regex(/^\d+$/) }),
]);

async function load(caller: Parameters<typeof authorizedAgent>[0], id: string) {
  const { agent } = await authorizedAgent(caller, id, "agents:manage");
  const [row, owner] = await Promise.all([db.agent.findUniqueOrThrow({ where: { id: agent.id } }), db.identity.findUniqueOrThrow({ where: { id: agent.identityId } })]);
  return { row, owner };
}

export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  const { row, owner } = await load(caller, id);
  return json(await erc8004View(row, owner));
});

export const PUT = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("manage", caller.id);
  const { row, owner } = await load(caller, id);
  const updated = await setExternalAgentKey(row, keyBody.parse(await req.json()).agentKey);
  return json(await erc8004View(updated, owner));
});

export const POST = withApiKey<P>(async (req, caller, { id }) => {
  rateLimit("manage", caller.id);
  const { row, owner } = await load(caller, id);
  const input = postBody.parse(await req.json());
  if ("agentWalletSignature" in input) {
    return json({ action: await prepareExternalAgentWallet(row, owner, { signature: input.agentWalletSignature as `0x${string}`, deadline: input.deadline }) });
  }
  const result = await confirmErc8004(row, owner, { op: input.op, txHash: input.txHash as `0x${string}` });
  return json(result, { status: result.ok ? 200 : 409 });
});
