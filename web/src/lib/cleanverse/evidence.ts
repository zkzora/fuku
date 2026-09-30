import { keccak256, stringToHex } from "viem";
import type { ComplianceEvidence } from "./types";

/**
 * Canonical JSON: object keys sorted recursively, bigints as decimal strings, undefined dropped.
 * `hashJson` in ids.ts depends on key order, so compliance evidence uses this instead.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

/** keccak256 of the canonical evidence JSON: the `complianceRef` carried into the proof and the guard. */
export function complianceRefOf(evidence: ComplianceEvidence): `0x${string}` {
  return keccak256(stringToHex(canonicalJson(evidence)));
}
