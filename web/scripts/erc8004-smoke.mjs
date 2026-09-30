#!/usr/bin/env node
/**
 * ERC-8004 smoke: an owner-controlled identity registers its agent on the canonical ERC-8004
 * Identity Registry through Fuku's API, with the owner's own key doing the signing:
 *   1. an identity with the owner's wallet bound by signature, and one agent;
 *   2. Fuku prepares register(agentURI); the owner's wallet sends it; Fuku confirms from the chain;
 *   3. Fuku prepares setAgentWallet with the agent key's EIP-712 AgentWalletSet signature; the
 *      owner's wallet sends it; Fuku confirms;
 *   4. independent reads: eth_getCode, getVersion, eip712Domain, ownerOf, getAgentWallet, tokenURI,
 *      and the public registration file;
 *   5. a mismatched confirmation is refused.
 *
 * Environment:
 *   FUKU_BASE_URL            web instance (default http://localhost:3002), live chain 10143
 *   MONAD_RPC_URL            JSON-RPC (default http://127.0.0.1:8546, a local fork of Monad testnet)
 *   SMOKE_OWNER_PRIVATE_KEY  the owner's wallet; it pays for two transactions
 *   SMOKE_API_KEY            caller that creates the identity (default: the demo key)
 *   DATABASE_URL             optional: releases the wallet from identities earlier runs created
 *
 * Usage: node scripts/erc8004-smoke.mjs     Exit code 0 when every check passes.
 */
import { createPublicClient, createWalletClient, defineChain, http, isAddressEqual, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = (process.env.FUKU_BASE_URL ?? "http://localhost:3002").replace(/\/+$/, "");
const RPC_URL = process.env.MONAD_RPC_URL ?? "http://127.0.0.1:8546";
const API_KEY = process.env.SMOKE_API_KEY ?? "fk_live_demo_ava_chen_2026";
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const ABI = parseAbi([
  "function getVersion() pure returns (string)",
  "function ownerOf(uint256) view returns (address)",
  "function getAgentWallet(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
]);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
  return Boolean(ok);
}
async function v1(method, route, body) {
  const res = await fetch(`${BASE_URL}/api/v1${route}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function main() {
  const key = process.env.SMOKE_OWNER_PRIVATE_KEY?.trim();
  if (!key) throw new Error("set SMOKE_OWNER_PRIVATE_KEY (a funded key; Hardhat account #3 on a local fork)");
  const owner = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({ id: chainId, name: "smoke", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
  const wallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });
  console.log(`Web ${BASE_URL} · RPC ${RPC_URL} · chain ${chainId} · owner ${owner.address}\n`);

  // 4a. the registry is there and is the canonical one
  const code = await publicClient.getCode({ address: REGISTRY });
  const version = await publicClient.readContract({ address: REGISTRY, abi: ABI, functionName: "getVersion" });
  const [, dName, dVersion, dChain, dContract] = await publicClient.readContract({ address: REGISTRY, abi: ABI, functionName: "eip712Domain" });
  check(
    "eth_getCode(IdentityRegistry) is a contract; getVersion 2.0.0; EIP-712 domain ERC8004IdentityRegistry v1 on this chain",
    code && code !== "0x" && version === "2.0.0" && dName === "ERC8004IdentityRegistry" && dVersion === "1" && Number(dChain) === chainId && isAddressEqual(dContract, REGISTRY),
    `${(code.length - 2) / 2} bytes`,
  );

  // 1. identity + bound wallet + agent
  const created = await v1("POST", "/identities", { displayName: `ERC-8004 smoke ${Date.now()}`, walletAddress: owner.address });
  const identityId = created.json?.identity?.id;
  if (!check("create an identity via the API", created.status === 201 && identityId, identityId ?? JSON.stringify(created.json).slice(0, 120))) return;
  if (process.env.DATABASE_URL) {
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    try {
      const released = await db.identity.updateMany({
        where: { walletAddress: owner.address.toLowerCase(), displayName: { startsWith: "ERC-8004 smoke " }, NOT: { id: identityId } },
        data: { walletAddress: null, walletVerifiedBy: null, walletVerifiedAt: null, walletProof: null },
      });
      if (released.count) console.log(`   released the owner wallet from ${released.count} earlier smoke identities`);
    } finally {
      await db.$disconnect();
    }
  }
  const ch = await v1("POST", `/identities/${encodeURIComponent(identityId)}/wallet`, { wallet: owner.address });
  const bound = await v1("PUT", `/identities/${encodeURIComponent(identityId)}/wallet`, { challengeId: ch.json?.challengeId, signature: await owner.signMessage({ message: ch.json?.message ?? "" }) });
  if (!check("bind the owner wallet with a signed challenge", bound.json?.identity?.walletVerifiedBy === "signature", bound.json?.error)) return;
  const reg = await v1("POST", "/agents", { name: "ERC-8004 smoke agent", capabilities: ["read_balances"], ownerIdentityId: identityId });
  const agentId = reg.json?.agent?.id;
  if (!check("register a Fuku agent", reg.status === 201 && agentId, agentId)) return;
  const route = `/agents/${encodeURIComponent(agentId)}/erc8004`;

  // 2. register(agentURI) from the owner's wallet
  const v0 = await v1("GET", route);
  const register = v0.json?.actions?.[0];
  check(
    "Fuku prepares register(agentURI) for the owner's wallet, to the canonical registry",
    register?.op === "erc8004Register" && isAddressEqual(register.tx.from, owner.address) && isAddressEqual(register.tx.to, REGISTRY),
    v0.json?.reason ?? v0.json?.error ?? register?.op,
  );
  if (!register) return;
  const regHash = await wallet.sendTransaction({ to: register.tx.to, data: register.tx.data });
  await publicClient.waitForTransactionReceipt({ hash: regHash });
  const regConf = await v1("POST", route, { op: "erc8004Register", txHash: regHash });
  check("the owner's register() is mined and confirmed by Fuku (Registered event, ownerOf)", regConf.json?.ok === true, `agent #${regConf.json?.agentId} tx ${regHash}`);

  // 3. setAgentWallet with the agent key's signature, from the owner's wallet
  const v1View = await v1("GET", route);
  const bind = v1View.json?.actions?.[0];
  check(
    "Fuku prepares setAgentWallet signed by the agent's own key (deadline inside 5 minutes)",
    bind?.op === "erc8004SetAgentWallet" && bind.deadline > 0 && v1View.json?.agentWallet && !isAddressEqual(v1View.json.agentWallet, owner.address),
    `agent key ${v1View.json?.agentWallet} deadline ${bind?.deadline}`,
  );
  if (!bind) return;
  const bindHash = await wallet.sendTransaction({ to: bind.tx.to, data: bind.tx.data });
  await publicClient.waitForTransactionReceipt({ hash: bindHash });
  const bindConf = await v1("POST", route, { op: "erc8004SetAgentWallet", txHash: bindHash });
  check("the owner's setAgentWallet() is mined and confirmed by Fuku (MetadataSet, getAgentWallet)", bindConf.json?.ok === true, `tx ${bindHash}`);

  // 4b. independent reads
  const done = await v1("GET", route);
  const id = BigInt(done.json?.agentId ?? -1);
  const [nftOwner, agentWallet, tokenURI] = await Promise.all([
    publicClient.readContract({ address: REGISTRY, abi: ABI, functionName: "ownerOf", args: [id] }),
    publicClient.readContract({ address: REGISTRY, abi: ABI, functionName: "getAgentWallet", args: [id] }),
    publicClient.readContract({ address: REGISTRY, abi: ABI, functionName: "tokenURI", args: [id] }),
  ]);
  check("ownerOf(agentId) is the owner's wallet", isAddressEqual(nftOwner, owner.address), nftOwner);
  check("getAgentWallet(agentId) is the agent's own key, not the owner", isAddressEqual(agentWallet, done.json?.agentWallet) && !isAddressEqual(agentWallet, owner.address), agentWallet);
  check("tokenURI(agentId) is the agentURI Fuku registered; Fuku reports complete", tokenURI === done.json?.agentURI && done.json?.complete === true, tokenURI);
  // A data: URI carries the file itself (minted before the agent id existed, so no registrations yet);
  // a public URL is fetched here and names this registration.
  const isData = tokenURI.startsWith("data:");
  const fileRes = await fetch(isData ? tokenURI : tokenURI.replace(/^https?:\/\/[^/]+/, BASE_URL));
  const file = await fileRes.json().catch(() => null);
  const typed = fileRes.status === 200 && file?.type === "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" && file?.name === "ERC-8004 smoke agent";
  check(
    isData ? "the agentURI is a self-contained data: URI holding the registration file" : "the registration file resolves and names this registration",
    typed && (isData || (file?.registrations?.[0]?.agentId === Number(id) && file?.registrations?.[0]?.agentRegistry === `eip155:${chainId}:${REGISTRY}`)),
    isData ? `${tokenURI.length} characters` : JSON.stringify(file?.registrations ?? file).slice(0, 120),
  );

  // 5. a mismatched confirmation is refused
  const wrong = await v1("POST", route, { op: "erc8004SetAgentWallet", txHash: regHash });
  check("confirming the register tx as setAgentWallet is refused", wrong.status === 409 && wrong.json?.ok === false, wrong.json?.error);

  console.log(`\nidentity ${identityId}\nagent ${agentId} = ERC-8004 agent #${id}\n  register        ${regHash}\n  setAgentWallet  ${bindHash}`);
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? ` (${failed} FAILED)` : ""}`);
    process.exitCode = failed ? 1 : 0;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
