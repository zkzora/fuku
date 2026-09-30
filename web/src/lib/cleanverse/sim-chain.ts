import { hexToString, isHex, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { CleanverseAPassSimAbi, CleanverseATokenSimAbi } from "../chain/abi";
import type { SimBackend } from "./provider";
import type { APassRecord, ATokenRule, AssetInfo } from "./types";

/**
 * Simulator backend that reads the Fuku-deployed CleanverseAPassSim / CleanverseATokenSim
 * contracts. Used when the chain is live (local node or Monad testnet) and no Cleanverse
 * credentials are configured. Every read goes to the chain; nothing here is Cleanverse-issued.
 */
export interface SimChainAddresses {
  apass: Address;
  atoken: Address;
}

/** bytes32 → readable label when it holds a right-padded ASCII string, otherwise the hex itself. */
export function bytes32Label(value: Hex): string | null {
  if (!isHex(value) || value === zeroHash) return null;
  const text = hexToString(value, { size: 32 }).replace(/\0+$/, "");
  return /^[\x20-\x7e]+$/.test(text) ? text : value;
}

/** Inverse of `bytes32Label` for rule fields: null / empty means "any" (bytes32(0)). */
export function labelToBytes32(label: string | null): Hex {
  if (!label) return zeroHash;
  if (isHex(label) && label.length === 66) return label;
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > 32) throw new Error(`label "${label}" does not fit in bytes32`);
  return `0x${Buffer.from(bytes).toString("hex").padEnd(64, "0")}` as Hex;
}

export class SimChainBackend implements SimBackend {
  readonly kind = "sim-chain" as const;

  constructor(
    private readonly client: PublicClient,
    private readonly addresses: SimChainAddresses,
  ) {}

  asset(): AssetInfo {
    return { symbol: "aUSDC-SIM", address: this.addresses.atoken.toLowerCase(), decimals: 6, source: "simulated" };
  }

  async getPass(wallet: string): Promise<APassRecord | null> {
    const p = await this.client.readContract({
      address: this.addresses.apass,
      abi: CleanverseAPassSimAbi,
      functionName: "passOf",
      args: [wallet as Address],
    });
    if (p.status === 0) return null;
    return {
      wallet: wallet.toLowerCase(),
      cvRecordId: bytes32Label(p.cvRecordId) ?? "",
      status: p.status,
      tier: p.tier,
      subTier: p.subTier,
      group: bytes32Label(p.group),
      subGroup: bytes32Label(p.subGroup),
      expiresAt: Number(p.expiresAt),
      countries: [],
      kycHash: null,
      source: "simulated",
      raw: { ...p, expiresAt: p.expiresAt.toString(), contract: this.addresses.apass },
    };
  }

  async getRule(): Promise<ATokenRule> {
    const [group, subGroup, minTier, minSubTier] = await this.rawRule();
    return {
      allowedGroup: bytes32Label(group),
      allowedSubGroup: bytes32Label(subGroup),
      minTier,
      minSubTier,
      blacklist: null,
      countries: null,
    };
  }

  async verify(wallet: string): Promise<number> {
    const [group, subGroup, minTier, minSubTier] = await this.rawRule();
    return this.client.readContract({
      address: this.addresses.apass,
      abi: CleanverseAPassSimAbi,
      functionName: "verify",
      args: [wallet as Address, { group, subGroup, minTier, minSubTier }],
    });
  }

  private rawRule() {
    return this.client.readContract({ address: this.addresses.atoken, abi: CleanverseATokenSimAbi, functionName: "rule" });
  }
}
