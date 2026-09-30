import { keccak256, stringToHex, type Hex } from "viem";
import { canonicalJson } from "./evidence";

/**
 * Travel Rule record for a guarded transfer. In live mode it is whatever Cleanverse's
 * `download_travel_rule` returns; in the simulator Fuku builds this record itself and marks it
 * `source: "simulated"`. Either way `travelRuleRef = keccak256(canonical JSON)` is stored on the
 * action, so the record can be checked against the reference later. It holds wallet addresses and
 * Cleanverse record ids only: no names, documents or other personal data.
 */
export interface SimulatedTravelRule {
  standard: "fuku-simulated-travel-rule/1";
  source: "simulated";
  chain: string;
  chainId: number;
  txHash: string;
  asset: { symbol: string; address: string; decimals: number };
  amount: string;
  originator: { wallet: string; cvRecordId: string | null };
  beneficiary: { wallet: string; cvRecordId: string | null };
  complianceRef: string;
  createdAt: string;
}

export function simulatedTravelRule(input: Omit<SimulatedTravelRule, "standard" | "source">): SimulatedTravelRule {
  return { standard: "fuku-simulated-travel-rule/1", source: "simulated", ...input };
}

export function travelRuleRefOf(record: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(record)));
}
