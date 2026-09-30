import { keccak256, stringToHex, type Hex } from "viem";

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newIdentityId(): string {
  return `fuku:id:0x${randomHex(20)}`;
}

export function newAgentId(): string {
  return `fuku:agent:0x${randomHex(20)}`;
}

export function randomToken(bytes = 24): string {
  return randomHex(bytes);
}

/** bytes32 representation of a Fuku id, used as the on-chain key. */
export function idToBytes32(id: string): Hex {
  return keccak256(stringToHex(id));
}

export function hashJson(value: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(value)));
}

export function hashString(value: string): Hex {
  return keccak256(stringToHex(value));
}

/** 0x3e91c4d0…b7a4 style display. */
export function shortHex(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return "—";
  const hex = value.includes("0x") ? value.slice(value.indexOf("0x")) : value;
  if (hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** fuku:agent:0x7a3f…9c21 */
export function shortId(id: string, head = 6, tail = 4): string {
  const parts = id.split(":");
  if (parts.length < 3) return id;
  return `${parts[0]}:${parts[1]}:${shortHex(parts.slice(2).join(":"), head, tail)}`;
}
