import { getAddress, isAddress, verifyMessage, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Wallet binding: the owner proves control of a wallet by signing a Fuku message (EIP-191
 * personal_sign) that names their Fuku identity, the wallet, a one-time nonce and an expiry.
 * A wallet address stored without this proof (or a verified Dynamic credential) is only a
 * declaration, and Cleanverse owner checks (R7) do not accept it.
 *
 * Verification: EOAs are checked locally. Contract wallets (ERC-1271, and ERC-6492 counterfactual
 * wallets) are checked through the chain when the settlement chain is live; in mock mode only EOAs
 * can bind.
 */
export interface BindingFields {
  identityId: string;
  wallet: string;
  nonce: string;
  chainId: number;
  issuedAt: string;
  expiresAt: string;
}

const HEADER = "Fuku wallet binding";

export function walletBindingMessage(f: BindingFields): string {
  return [
    HEADER,
    `I control this wallet and bind it to Fuku identity ${f.identityId}.`,
    `Wallet: ${getAddress(f.wallet)}`,
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expiresAt}`,
  ].join("\n");
}

export function parseWalletBindingMessage(message: string): BindingFields | null {
  const lines = message.split("\n");
  if (lines[0] !== HEADER || lines.length !== 7) return null;
  const identity = /^I control this wallet and bind it to Fuku identity (\S+)\.$/.exec(lines[1])?.[1];
  const field = (i: number, name: string) => (lines[i].startsWith(`${name}: `) ? lines[i].slice(name.length + 2) : null);
  const wallet = field(2, "Wallet");
  const chainId = Number(field(3, "Chain ID"));
  const nonce = field(4, "Nonce");
  const issuedAt = field(5, "Issued At");
  const expiresAt = field(6, "Expiration Time");
  if (!identity || !wallet || !isAddress(wallet) || !Number.isInteger(chainId) || !nonce || !issuedAt || !expiresAt) return null;
  return { identityId: identity, wallet, nonce, chainId, issuedAt, expiresAt };
}

/** True when `signature` over `message` is valid for `wallet` (EOA locally; contract wallets via `client`). */
export async function verifyWalletSignature(opts: {
  wallet: string;
  message: string;
  signature: Hex;
  client?: PublicClient | null;
}): Promise<boolean> {
  const address = getAddress(opts.wallet);
  try {
    if (opts.client) return await opts.client.verifyMessage({ address, message: opts.message, signature: opts.signature });
    return await verifyMessage({ address, message: opts.message, signature: opts.signature });
  } catch {
    return false;
  }
}

/** A signed binding proof, as stored in Identity.walletProof. Used by the seed with the demo key. */
export async function signWalletBinding(account: PrivateKeyAccount, f: Omit<BindingFields, "wallet">) {
  const message = walletBindingMessage({ ...f, wallet: account.address });
  const signature = await account.signMessage({ message });
  return { message, signature };
}
