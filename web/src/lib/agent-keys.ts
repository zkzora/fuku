import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * Each agent's own key: an EOA that becomes the agent's ERC-8004 `agentWallet`. Fuku generates it and
 * keeps it sealed at rest with AES-256-GCM under FUKU_AGENT_KEY_SECRET, bound to the agent id so a
 * sealed key cannot be moved to another agent. The owner's wallet never holds it, and it moves no
 * funds through Fuku. Today it signs one thing: the EIP-712 AgentWalletSet proof that lets the owner
 * bind it on the ERC-8004 Identity Registry.
 */
const MIN_SECRET_LENGTH = 32;

export class AgentKeySecretMissing extends Error {
  constructor() {
    super(`Set FUKU_AGENT_KEY_SECRET (at least ${MIN_SECRET_LENGTH} random characters) so agents can have their own keys.`);
    this.name = "AgentKeySecretMissing";
  }
}

type Env = Record<string, string | undefined>;

function sealingKey(env: Env): Buffer {
  const raw = env.FUKU_AGENT_KEY_SECRET?.trim();
  if (!raw || raw.length < MIN_SECRET_LENGTH) throw new AgentKeySecretMissing();
  return createHash("sha256").update(`fuku:agent-key:v1:${raw}`).digest();
}

export function agentKeysConfigured(env: Env = process.env): boolean {
  const raw = env.FUKU_AGENT_KEY_SECRET?.trim();
  return Boolean(raw && raw.length >= MIN_SECRET_LENGTH);
}

export function sealAgentKey(agentId: string, privateKey: Hex, env: Env = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(env), iv);
  cipher.setAAD(Buffer.from(agentId, "utf8"));
  const data = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function openAgentKey(agentId: string, sealed: string, env: Env = process.env): PrivateKeyAccount {
  const box = JSON.parse(sealed) as { v: number; iv: string; tag: string; data: string };
  if (box.v !== 1) throw new Error(`unknown agent key format v${box.v}`);
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(env), Buffer.from(box.iv, "base64"));
  decipher.setAAD(Buffer.from(agentId, "utf8"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const key = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
  return privateKeyToAccount(`0x${key.toString("hex")}`);
}

/** A fresh key for `agentId`: its address and the sealed private key to store. */
export function newAgentKey(agentId: string, env: Env = process.env): { address: Address; sealed: string } {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, sealed: sealAgentKey(agentId, privateKey, env) };
}
