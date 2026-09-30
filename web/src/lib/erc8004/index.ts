import {
  encodeFunctionData,
  isAddressEqual,
  parseEventLogs,
  zeroHash,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { Erc8004IdentityRegistryAbi } from "./abi";

/**
 * The canonical ERC-8004 Identity Registry (not Fuku's own registries). Everything here follows
 * github.com/erc-8004/erc-8004-contracts at `ERC8004_SOURCE.commit`:
 *  - the ABI (./abi.ts, copied verbatim from abis/IdentityRegistry.json);
 *  - AgentWalletSet and its 5-minute deadline window (contracts/IdentityRegistryUpgradeable.sol);
 *  - the registration file (ERC8004SPEC.md, "Agent URI and Agent Registration File");
 *  - the proxy addresses (scripts/addresses.ts, TESTNET_ADDRESSES).
 * The EIP-712 domain is read from the contract itself (EIP-5267 `eip712Domain()`), never assumed.
 */
export const ERC8004_SOURCE = {
  repo: "https://github.com/erc-8004/erc-8004-contracts",
  commit: "b9e466c250744a7e06b13dff9d3c2844ed64f825",
  implementationVersion: "2.0.0",
} as const;

/** Monad testnet proxies. Mainnet addresses are deliberately absent: Fuku does not use mainnet. */
export const ERC8004_MONAD_TESTNET = {
  chainId: 10143,
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const satisfies { chainId: number; identity: Address; reputation: Address; validation: Address };

/** The canonical Identity Registry on `chainId`, or null where Fuku knows none. */
export function erc8004IdentityRegistry(chainId: number): Address | null {
  return chainId === ERC8004_MONAD_TESTNET.chainId ? ERC8004_MONAD_TESTNET.identity : null;
}

/** `{namespace}:{chainId}:{identityRegistry}`, the spec's global registry id. */
export function agentRegistryId(chainId: number, registry: Address): string {
  return `eip155:${chainId}:${registry}`;
}

/** AGENT_WALLET_SET_TYPEHASH = keccak256 of this string, in IdentityRegistryUpgradeable.sol. */
export const AGENT_WALLET_SET_TYPE = "AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)";
export const AGENT_WALLET_SET_TYPES = {
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "owner", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
/** setAgentWallet reverts "deadline too far" beyond block.timestamp + 5 minutes, and "expired" after it. */
export const MAX_DEADLINE_DELAY_S = 300;

export interface Erc8004Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * The registry's EIP-712 domain, read from the contract. Refuses a domain that is not the one the
 * source defines (name "ERC8004IdentityRegistry", version "1", this chain, this contract, no salt),
 * which would mean the address is not the canonical registry.
 */
export async function readErc8004Domain(client: PublicClient, registry: Address): Promise<Erc8004Domain> {
  const [fields, name, version, chainId, verifyingContract, salt, extensions] = await client.readContract({
    address: registry,
    abi: Erc8004IdentityRegistryAbi,
    functionName: "eip712Domain",
  });
  const onChainId = Number(chainId);
  if (
    fields !== "0x0f" ||
    name !== "ERC8004IdentityRegistry" ||
    version !== "1" ||
    onChainId !== (await client.getChainId()) ||
    !isAddressEqual(verifyingContract, registry) ||
    salt !== zeroHash ||
    extensions.length > 0
  ) {
    throw new Error(`unexpected EIP-712 domain at ${registry}: ${name} v${version} chain ${onChainId}`);
  }
  return { name, version, chainId: onChainId, verifyingContract };
}

export interface AgentWalletSet {
  agentId: bigint;
  newWallet: Address;
  owner: Address;
  deadline: bigint;
}

/** The agent key's proof of control, as setAgentWallet checks it (EOA path: ECDSA over the v4 digest). */
export function signAgentWalletSet(agentKey: PrivateKeyAccount, domain: Erc8004Domain, message: AgentWalletSet): Promise<Hex> {
  return agentKey.signTypedData({ domain, types: AGENT_WALLET_SET_TYPES, primaryType: "AgentWalletSet", message });
}

export function registerCalldata(agentURI: string): Hex {
  return encodeFunctionData({ abi: Erc8004IdentityRegistryAbi, functionName: "register", args: [agentURI] });
}

export function setAgentWalletCalldata(m: Pick<AgentWalletSet, "agentId" | "newWallet" | "deadline">, signature: Hex): Hex {
  return encodeFunctionData({ abi: Erc8004IdentityRegistryAbi, functionName: "setAgentWallet", args: [m.agentId, m.newWallet, m.deadline, signature] });
}

/**
 * The registration file (ERC8004SPEC.md). `supportedTrust` is empty: Fuku claims discovery only.
 * Without a public URL there is no web service and no image to point at, so both are left empty.
 */
export function registrationFile(input: {
  name: string;
  description: string;
  image: string;
  url: string;
  active: boolean;
  registration: { agentId: bigint; chainId: number; registry: Address } | null;
}) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: input.name,
    description: input.description,
    image: input.image,
    services: input.url ? [{ name: "web", endpoint: input.url }] : [],
    x402Support: false,
    active: input.active,
    registrations: input.registration
      ? [{ agentId: Number(input.registration.agentId), agentRegistry: agentRegistryId(input.registration.chainId, input.registration.registry) }]
      : [],
    supportedTrust: [] as string[],
  };
}

/** A self-contained agentURI: the registration file as a base64 JSON data URI (the spec's on-chain option). */
export function registrationDataUri(file: ReturnType<typeof registrationFile>): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file), "utf8").toString("base64")}`;
}

/** The agentId minted by a register() receipt: the registry's Registered event for `owner` and `agentURI`. */
export function registeredIn(logs: Log[], registry: Address, owner: Address, agentURI: string): bigint | null {
  const events = parseEventLogs({ abi: Erc8004IdentityRegistryAbi, eventName: "Registered", logs });
  const hit = events.find((e) => isAddressEqual(e.address, registry) && isAddressEqual(e.args.owner, owner) && e.args.agentURI === agentURI);
  return hit ? hit.args.agentId : null;
}

/** True when the logs hold MetadataSet(agentId, "agentWallet", wallet) from the registry. */
export function agentWalletSetIn(logs: Log[], registry: Address, agentId: bigint, wallet: Address): boolean {
  const events = parseEventLogs({ abi: Erc8004IdentityRegistryAbi, eventName: "MetadataSet", logs });
  return events.some(
    (e) =>
      isAddressEqual(e.address, registry) &&
      e.args.agentId === agentId &&
      e.args.metadataKey === "agentWallet" &&
      e.args.metadataValue.toLowerCase() === wallet.toLowerCase(),
  );
}

export { Erc8004IdentityRegistryAbi };
