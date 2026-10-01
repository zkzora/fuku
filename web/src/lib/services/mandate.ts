import { getAbiItem, getAddress, isAddress, type Address } from "viem";
import { db } from "../db";
import { chainConfig, chainReader, spendGuardAddress } from "../chain";
import { FukuSpendGuardAbi } from "../chain/abi";
import { idToBytes32 } from "../ids";
import { fetchRegistryEvents } from "../integrations/envio";
import { DEMO_RECIPIENTS } from "../cleanverse/demo";

export interface MandatePayee {
  address: string;
  /** The demo recipient's name when Fuku knows the address, otherwise null. */
  label: string | null;
}

export interface MandatePayees {
  payees: MandatePayee[];
  /** events: every PayeeSet the guard emitted for this mandate; known-addresses: only addresses Fuku knows were checked. */
  source: "events" | "known-addresses";
}

const PAYEE_SET = getAbiItem({ abi: FukuSpendGuardAbi, name: "PayeeSet" });

/**
 * The payees the owner's wallet approved for this agent's mandate. The guard keeps them in a mapping
 * that cannot be listed, so the candidates come from its PayeeSet events (eth_getLogs on a local node,
 * Envio HyperSync elsewhere) and each one is confirmed with isPayee. Without an event source the
 * candidates are the addresses Fuku knows (the demo recipients and the agent's past counterparties),
 * and `source` says so.
 */
export async function mandatePayees(agentId: string, wallet: string): Promise<MandatePayees | null> {
  const guard = spendGuardAddress();
  const client = chainReader();
  if (!guard || !client || !isAddress(wallet)) return null;
  const key = idToBytes32(agentId);
  const owner = getAddress(wallet);

  let candidates: string[] | null = null;
  try {
    if (chainConfig().id === 31337) {
      const logs = await client.getLogs({ address: guard, event: PAYEE_SET, args: { agentId: key, wallet: owner }, fromBlock: BigInt(0), toBlock: "latest" });
      candidates = logs.map((l) => String(l.args.payee));
    } else if (process.env.ENVIO_API_TOKEN?.trim()) {
      const feed = await fetchRegistryEvents({ subjects: [agentId], limit: 10_000 });
      candidates = feed.events
        .filter((e) => e.kind === "PayeeSet" && String(e.args.wallet).toLowerCase() === owner.toLowerCase())
        .map((e) => String(e.args.payee));
    }
  } catch {
    candidates = null;
  }
  const source: MandatePayees["source"] = candidates ? "events" : "known-addresses";
  if (!candidates) {
    const past = await db.agentAction.findMany({ where: { agentId, counterparty: { not: null } }, select: { counterparty: true }, distinct: ["counterparty"] });
    candidates = [...DEMO_RECIPIENTS.map((r) => r.address), ...past.map((p) => p.counterparty as string)];
  }

  const unique = [...new Set(candidates.filter((a) => isAddress(a)).map((a) => getAddress(a)))];
  const approved = await Promise.all(
    unique.map(async (payee) =>
      (await client.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "isPayee", args: [key, owner, payee as Address] })) ? payee : null,
    ),
  );
  const labels = new Map(DEMO_RECIPIENTS.map((r) => [r.address.toLowerCase(), r.name]));
  return {
    payees: approved.filter((a): a is `0x${string}` => a !== null).map((address) => ({ address, label: labels.get(address.toLowerCase()) ?? null })),
    source,
  };
}
