import { NextResponse } from "next/server";
import type { Address } from "viem";
import { db } from "@/lib/db";
import { registrationFile } from "@/lib/erc8004";
import { erc8004BaseUrl } from "@/lib/services/erc8004";

/**
 * Public: the ERC-8004 registration file an agent's `agentURI` resolves to (ERC8004SPEC.md, "Agent URI
 * and Agent Registration File"). Served only once the agent's registration was confirmed on-chain.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agent = await db.agent.findUnique({ where: { id } });
  if (!agent?.erc8004Id || !agent.erc8004Registry || !agent.erc8004ChainId) {
    return NextResponse.json({ error: "This agent is not registered on ERC-8004." }, { status: 404 });
  }
  const base = erc8004BaseUrl();
  const file = registrationFile({
    name: agent.name,
    description: agent.description ?? `${agent.name}, an AI agent whose owner governs it through Fuku.`,
    image: `${base}/fuku-logo.png`,
    url: base,
    active: agent.status === "active",
    registration: { agentId: BigInt(agent.erc8004Id), chainId: agent.erc8004ChainId, registry: agent.erc8004Registry as Address },
  });
  return NextResponse.json(file, { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } });
}
