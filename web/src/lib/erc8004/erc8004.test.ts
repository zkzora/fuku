import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  hashDomain,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  toFunctionSelector,
  zeroHash,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AGENT_WALLET_SET_TYPE,
  AGENT_WALLET_SET_TYPES,
  ERC8004_MONAD_TESTNET,
  Erc8004IdentityRegistryAbi,
  agentWalletSetIn,
  erc8004IdentityRegistry,
  readErc8004Domain,
  registerCalldata,
  registeredIn,
  registrationFile,
  setAgentWalletCalldata,
  signAgentWalletSet,
} from ".";
import { AgentKeySecretMissing, agentKeysConfigured, newAgentKey, openAgentKey } from "../agent-keys";

const REGISTRY = ERC8004_MONAD_TESTNET.identity;
const DOMAIN = { name: "ERC8004IdentityRegistry", version: "1", chainId: 10143, verifyingContract: REGISTRY } as const;
const OWNER = privateKeyToAccount(generatePrivateKey()).address;

function log(address: Address, topics: Hex[], data: Hex): Log {
  return { address, topics: topics as [Hex, ...Hex[]], data, blockHash: zeroHash, blockNumber: BigInt(1), logIndex: 0, transactionHash: zeroHash, transactionIndex: 0, removed: false };
}

describe("ERC-8004 identity registry", () => {
  it("knows only the Monad testnet registry (no mainnet)", () => {
    assert.equal(erc8004IdentityRegistry(10143), "0x8004A818BFB912233c491871b3d84c89A494BD9e");
    assert.equal(erc8004IdentityRegistry(143), null);
    assert.equal(erc8004IdentityRegistry(31337), null);
  });

  it("AgentWalletSet typed data equals the contract's digest (typehash string, abi.encode, EIP-712 v4)", async () => {
    const agentKey = privateKeyToAccount(generatePrivateKey());
    const message = { agentId: BigInt(7), newWallet: agentKey.address, owner: OWNER, deadline: BigInt(1_900_000_000) };
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
        [keccak256(stringToHex(AGENT_WALLET_SET_TYPE)), message.agentId, message.newWallet, message.owner, message.deadline],
      ),
    );
    const separator = hashDomain({
      domain: { ...DOMAIN, chainId: BigInt(DOMAIN.chainId) },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    });
    const solidityDigest = keccak256(concat(["0x1901", separator, structHash]));
    assert.equal(hashTypedData({ domain: DOMAIN, types: AGENT_WALLET_SET_TYPES, primaryType: "AgentWalletSet", message }), solidityDigest);

    const signature = await signAgentWalletSet(agentKey, DOMAIN, message);
    assert.equal(await recoverTypedDataAddress({ domain: DOMAIN, types: AGENT_WALLET_SET_TYPES, primaryType: "AgentWalletSet", message, signature }), agentKey.address);
  });

  it("encodes register(string) and setAgentWallet(uint256,address,uint256,bytes)", () => {
    const uri = "https://fuku.example/api/erc8004/agents/x/registration.json";
    const reg = registerCalldata(uri);
    assert.equal(reg.slice(0, 10), toFunctionSelector("register(string)"));
    assert.deepEqual(decodeFunctionData({ abi: Erc8004IdentityRegistryAbi, data: reg }).args, [uri]);
    const set = setAgentWalletCalldata({ agentId: BigInt(3), newWallet: OWNER, deadline: BigInt(99) }, "0x1234");
    assert.equal(set.slice(0, 10), toFunctionSelector("setAgentWallet(uint256,address,uint256,bytes)"));
    assert.deepEqual(decodeFunctionData({ abi: Erc8004IdentityRegistryAbi, data: set }).args, [BigInt(3), OWNER, BigInt(99), "0x1234"]);
  });

  it("reads the EIP-712 domain from the contract and refuses a foreign one", async () => {
    const fake = (name: string) =>
      ({
        getChainId: async () => 10143,
        readContract: async () => ["0x0f", name, "1", BigInt(10143), REGISTRY, zeroHash, []],
      }) as unknown as PublicClient;
    assert.deepEqual(await readErc8004Domain(fake("ERC8004IdentityRegistry"), REGISTRY), DOMAIN);
    await assert.rejects(() => readErc8004Domain(fake("SomethingElse"), REGISTRY), /unexpected EIP-712 domain/);
  });

  it("accepts only the registry's Registered event for this owner and URI, and MetadataSet for this wallet", () => {
    const uri = "https://fuku.example/a.json";
    const registered = log(
      REGISTRY,
      encodeEventTopics({ abi: Erc8004IdentityRegistryAbi, eventName: "Registered", args: { agentId: BigInt(12), owner: OWNER } }) as Hex[],
      encodeAbiParameters([{ type: "string" }], [uri]),
    );
    assert.equal(registeredIn([registered], REGISTRY, OWNER, uri), BigInt(12));
    assert.equal(registeredIn([{ ...registered, address: "0x0000000000000000000000000000000000000001" }], REGISTRY, OWNER, uri), null, "another contract");
    assert.equal(registeredIn([registered], REGISTRY, "0x0000000000000000000000000000000000000002", uri), null, "another owner");
    assert.equal(registeredIn([registered], REGISTRY, OWNER, `${uri}?x`), null, "another URI");

    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    const metadata = log(
      REGISTRY,
      encodeEventTopics({ abi: Erc8004IdentityRegistryAbi, eventName: "MetadataSet", args: { agentId: BigInt(12), indexedMetadataKey: "agentWallet" } }) as Hex[],
      encodeAbiParameters([{ type: "string" }, { type: "bytes" }], ["agentWallet", wallet.toLowerCase() as Hex]),
    );
    assert.equal(agentWalletSetIn([metadata], REGISTRY, BigInt(12), wallet), true);
    assert.equal(agentWalletSetIn([metadata], REGISTRY, BigInt(13), wallet), false, "another agent");
    assert.equal(agentWalletSetIn([metadata], REGISTRY, BigInt(12), OWNER), false, "another wallet");
  });

  it("builds the registration file the spec describes, claiming discovery only", () => {
    const file = registrationFile({
      name: "Payments Agent",
      description: "Pays suppliers",
      image: "https://fuku.example/fuku-logo.png",
      url: "https://fuku.example",
      active: true,
      registration: { agentId: BigInt(12), chainId: 10143, registry: REGISTRY },
    });
    assert.equal(file.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    assert.deepEqual(file.registrations, [{ agentId: 12, agentRegistry: "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e" }]);
    assert.deepEqual(file.supportedTrust, []);
    assert.deepEqual(file.services, [{ name: "web", endpoint: "https://fuku.example" }]);
  });
});

describe("agent keys", () => {
  const env = { FUKU_AGENT_KEY_SECRET: "x".repeat(40) };

  it("seal and open round-trip, bound to the agent id", () => {
    const { address, sealed } = newAgentKey("fuku:agent:0x01", env);
    assert.equal(openAgentKey("fuku:agent:0x01", sealed, env).address, address);
    assert.throws(() => openAgentKey("fuku:agent:0x02", sealed, env), "a sealed key cannot be moved to another agent");
    assert.throws(() => openAgentKey("fuku:agent:0x01", sealed, { FUKU_AGENT_KEY_SECRET: "y".repeat(40) }));
    assert.ok(!sealed.includes(address.slice(2)), "the sealed box does not carry the address in clear");
  });

  it("refuse to work without a strong secret", () => {
    assert.equal(agentKeysConfigured({}), false);
    assert.equal(agentKeysConfigured({ FUKU_AGENT_KEY_SECRET: "short" }), false);
    assert.equal(agentKeysConfigured(env), true);
    assert.throws(() => newAgentKey("fuku:agent:0x01", { FUKU_AGENT_KEY_SECRET: "short" }), AgentKeySecretMissing);
  });
});
