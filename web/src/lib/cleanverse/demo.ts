import { isHex, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/**
 * Demo counterparties for the Cleanverse flow. Deterministic, testnet-only addresses derived
 * from labels; nobody should ever fund them outside the simulator.
 */
const demoKey = (label: string): Hex => keccak256(stringToHex(`fuku:demo:${label}`));
export const demoAddress = (label: string): Address => privateKeyToAddress(demoKey(label));

export interface DemoRecipient {
  label: string;
  name: string;
  address: Address;
  /** What the simulator has on file for this wallet. */
  apass: { status: 1 | 2; tier: number } | null;
  expect: "ok" | "frozen" | "none";
}

export const DEMO_RECIPIENTS: DemoRecipient[] = [
  { label: "nusantara", name: "Nusantara Supplies", address: demoAddress("nusantara"), apass: { status: 1, tier: 2 }, expect: "ok" },
  { label: "frozen", name: "Frozen wallet", address: demoAddress("frozen"), apass: { status: 2, tier: 2 }, expect: "frozen" },
  { label: "unverified", name: "Unverified wallet", address: demoAddress("unverified"), apass: null, expect: "none" },
];

/**
 * Ava's funding-wallet key: DEMO_OWNER_PRIVATE_KEY when set, otherwise a key derived from a public
 * label. The derived key is public (anyone can recompute it), so it only serves mock-chain demos,
 * where it lets the seed sign a real wallet-binding proof. Never fund its address.
 */
export function demoOwnerKey(env: Record<string, string | undefined> = process.env): { key: Hex; derived: boolean } {
  const raw = env.DEMO_OWNER_PRIVATE_KEY?.trim();
  const key = raw ? ((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex) : null;
  if (key && isHex(key) && key.length === 66) return { key, derived: false };
  return { key: demoKey("owner:ava-chen"), derived: true };
}

/** Ava's wallet: the address of demoOwnerKey(). */
export function demoOwnerWallet(env: Record<string, string | undefined> = process.env): string {
  return privateKeyToAddress(demoOwnerKey(env).key).toLowerCase();
}

/** The A-Token symbol A-Token passports list; the simulator's own symbol is aUSDC-SIM. */
export const DEMO_ATOKEN_SYMBOL = "aUSDC";

/** Stand-in address for the simulated A-Token in mock-chain mode (no contract exists there). */
export const SIM_FIXTURE_ATOKEN = demoAddress("atoken:ausdc-sim");
