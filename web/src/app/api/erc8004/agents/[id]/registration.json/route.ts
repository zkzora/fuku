import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentRegistrationFile } from "@/lib/services/erc8004";

/**
 * Public: the ERC-8004 registration file an agent's `agentURI` resolves to (ERC8004SPEC.md, "Agent URI
 * and Agent Registration File"), when that URI is this endpoint (FUKU_PUBLIC_URL): from the moment the
 * registration is prepared (so it resolves before the owner registers), with `registrations` filled in
 * once the registration is confirmed.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agent = await db.agent.findUnique({ where: { id } });
  if (!agent?.erc8004Uri || agent.erc8004Uri.startsWith("data:")) {
    return NextResponse.json({ error: "This agent has no ERC-8004 registration served here." }, { status: 404 });
  }
  return NextResponse.json(agentRegistrationFile(agent), { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } });
}
