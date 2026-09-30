import type { CleanverseBackend, CleanverseMode } from "./types";

export type Env = Record<string, string | undefined>;

/**
 * Cleanverse mode, one code path for all of them:
 *  - live:      CLEANVERSE_API_ID + CLEANVERSE_API_KEY set and CLEANVERSE_MODE != "sim".
 *  - simulated: no credentials (or CLEANVERSE_MODE=sim). With the chain live, the Fuku-deployed
 *               simulator contracts (CLEANVERSE_SIM_APASS / CLEANVERSE_SIM_ATOKEN); with the chain
 *               mocked, DB fixtures with the same shapes.
 *  - off:       CLEANVERSE_MODE=off, or the chain is live without simulator addresses and no
 *               credentials. Value actions on an A-Token passport are then blocked (R7 PROVIDER_OFF).
 */
export interface ModeInputs {
  env?: Env;
  chainLive: boolean;
}

export function resolveCleanverse({ env = process.env, chainLive }: ModeInputs): {
  mode: CleanverseMode;
  backend: CleanverseBackend | null;
} {
  const forced = env.CLEANVERSE_MODE?.trim().toLowerCase();
  if (forced === "off") return { mode: "off", backend: null };
  const hasCreds = Boolean(env.CLEANVERSE_API_ID?.trim() && env.CLEANVERSE_API_KEY?.trim());
  if (hasCreds && forced !== "sim") return { mode: "live", backend: "api" };
  if (!chainLive) return { mode: "simulated", backend: "sim-fixtures" };
  if (env.CLEANVERSE_SIM_APASS?.trim() && env.CLEANVERSE_SIM_ATOKEN?.trim()) return { mode: "simulated", backend: "sim-chain" };
  return { mode: "off", backend: null };
}

/** Cleanverse chain identifier for Monad testnet (unverified; see docs/CLEANVERSE.md). */
export function cleanverseChain(env: Env = process.env): string {
  return env.CLEANVERSE_CHAIN?.trim() || "monad";
}
