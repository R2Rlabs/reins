import { getAddress, isAddress, recoverTypedDataAddress, type Hex } from "viem";
import { splitSignature } from "./signing.js";
import type { Network, Signature } from "./types.js";

/**
 * `ApproveBuilderFee`: the one-time signature a user gives before their orders
 * can carry a builder's fee. Checked against the Python SDK's
 * `sign_approve_builder_fee` and `examples/basic_builder_fee.py`.
 *
 * Unlike orders, this is a *user-signed* action: plain EIP-712 over the
 * fields, no msgpack and no phantom agent, and it must come from the user's
 * main wallet rather than an API wallet. The domain's chainId is whatever
 * `signatureChainId` says — the SDK uses 0x66eee, a browser wallet uses the
 * chain it is connected to, and Hyperliquid verifies against either.
 */

export const USER_SIGNED_DOMAIN_NAME = "HyperliquidSignTransaction";

export const APPROVE_BUILDER_FEE_TYPES = {
  "HyperliquidTransaction:ApproveBuilderFee": [
    { name: "hyperliquidChain", type: "string" },
    { name: "maxFeeRate", type: "string" },
    { name: "builder", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

export const APPROVE_BUILDER_FEE_PRIMARY_TYPE = "HyperliquidTransaction:ApproveBuilderFee";

/** What eth_signTypedData_v4 wants listed alongside the action's own types. */
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export interface ApproveBuilderFeeAction {
  type: "approveBuilderFee";
  signatureChainId: Hex;
  hyperliquidChain: "Mainnet" | "Testnet";
  /** A percentage string: "0.02%" is 2 bp. */
  maxFeeRate: string;
  builder: string;
  nonce: number;
}

/**
 * Tenths of a basis point, as orders carry them, to the percentage string the
 * approval takes. 10 tenths is 1 bp is 0.01%, so tenths / 1000 is the percent.
 * Getting this wrong by a factor of ten would approve a fee every order then
 * exceeds, so it is done in integers and never through floating point.
 */
export function maxFeeRate(tenthsBps: number): string {
  if (!Number.isInteger(tenthsBps) || tenthsBps <= 0) {
    throw new Error(`A builder fee must be a positive whole number of tenths of a bp, got ${tenthsBps}.`);
  }
  const whole = Math.floor(tenthsBps / 1000);
  const fraction = String(tenthsBps % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}

export function approveBuilderFeeAction(input: {
  builder: string;
  maxFeeTenthsBps: number;
  network: Network;
  signatureChainId: Hex;
  nonce: number;
}): ApproveBuilderFeeAction {
  if (!isAddress(input.builder, { strict: false })) {
    throw new Error(`"${input.builder}" is not an address.`);
  }
  return {
    type: "approveBuilderFee",
    signatureChainId: input.signatureChainId,
    hyperliquidChain: input.network === "mainnet" ? "Mainnet" : "Testnet",
    maxFeeRate: maxFeeRate(input.maxFeeTenthsBps),
    builder: input.builder.toLowerCase(),
    nonce: input.nonce,
  };
}

function userSignedDomain(action: ApproveBuilderFeeAction) {
  return {
    name: USER_SIGNED_DOMAIN_NAME,
    version: "1",
    chainId: Number.parseInt(action.signatureChainId, 16),
    verifyingContract: "0x0000000000000000000000000000000000000000" as const,
  };
}

/** The EIP-712 payload, in the shape a browser wallet's eth_signTypedData_v4 takes. */
export function approveBuilderFeeTypedData(action: ApproveBuilderFeeAction) {
  return {
    domain: userSignedDomain(action),
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...APPROVE_BUILDER_FEE_TYPES },
    primaryType: APPROVE_BUILDER_FEE_PRIMARY_TYPE as typeof APPROVE_BUILDER_FEE_PRIMARY_TYPE,
    message: {
      hyperliquidChain: action.hyperliquidChain,
      maxFeeRate: action.maxFeeRate,
      builder: action.builder,
      nonce: action.nonce,
    },
  };
}

/** The address that produced a signature over this action. */
export async function recoverApprover(action: ApproveBuilderFeeAction, signature: Hex): Promise<string> {
  return recoverTypedDataAddress({
    domain: userSignedDomain(action),
    types: APPROVE_BUILDER_FEE_TYPES,
    primaryType: APPROVE_BUILDER_FEE_PRIMARY_TYPE,
    message: {
      hyperliquidChain: action.hyperliquidChain,
      maxFeeRate: action.maxFeeRate,
      builder: action.builder as Hex,
      nonce: BigInt(action.nonce),
    },
    signature,
  });
}

export interface ApprovalRequest {
  action: ApproveBuilderFeeAction;
  nonce: number;
  signature: Signature;
}

/**
 * Checks a signed approval from the browser before anything is sent. The page
 * is ours, but it runs where extensions and other tabs can reach it, so the
 * server trusts only what it asked for: the builder, the rate and the network
 * must be exactly its own, the nonce fresh, and the signature must recover to
 * the wallet the page says signed it.
 */
export async function checkSignedApproval(
  expected: { builder: string; maxFeeRate: string; network: Network; now: number },
  submitted: { action: unknown; signature: unknown; user: unknown },
): Promise<{ request: ApprovalRequest; user: string }> {
  const action = submitted.action as Partial<ApproveBuilderFeeAction> | null;
  if (!action || typeof action !== "object") throw new Error("No action was submitted.");
  if (action.type !== "approveBuilderFee") throw new Error("That is not a builder fee approval.");
  if (action.builder !== expected.builder.toLowerCase()) {
    throw new Error(`The approval names builder ${String(action.builder)}, not ${expected.builder}.`);
  }
  if (action.maxFeeRate !== expected.maxFeeRate) {
    throw new Error(`The approval is for ${String(action.maxFeeRate)}, not ${expected.maxFeeRate}.`);
  }
  const chain = expected.network === "mainnet" ? "Mainnet" : "Testnet";
  if (action.hyperliquidChain !== chain) {
    throw new Error(`The approval is for ${String(action.hyperliquidChain)}, not ${chain}.`);
  }
  if (typeof action.signatureChainId !== "string" || !/^0x[0-9a-f]+$/i.test(action.signatureChainId)) {
    throw new Error("The approval has no valid signatureChainId.");
  }
  if (typeof action.nonce !== "number" || Math.abs(expected.now - action.nonce) > 10 * 60_000) {
    throw new Error("The approval's nonce is not a current timestamp. Reload the page and sign again.");
  }
  if (typeof submitted.signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(submitted.signature)) {
    throw new Error("The wallet did not return a 65-byte signature.");
  }
  if (typeof submitted.user !== "string" || !isAddress(submitted.user, { strict: false })) {
    throw new Error("The page did not say which wallet signed.");
  }

  // Rebuilt from the checked fields, so nothing extra the page added is sent on.
  const clean: ApproveBuilderFeeAction = {
    type: "approveBuilderFee",
    signatureChainId: action.signatureChainId as Hex,
    hyperliquidChain: action.hyperliquidChain,
    maxFeeRate: action.maxFeeRate,
    builder: action.builder,
    nonce: action.nonce,
  };
  const signer = await recoverApprover(clean, submitted.signature as Hex);
  if (getAddress(signer) !== getAddress(submitted.user)) {
    throw new Error(`The signature is from ${signer}, not the connected wallet ${submitted.user}.`);
  }
  return {
    request: { action: clean, nonce: clean.nonce, signature: splitSignature(submitted.signature as Hex) },
    user: getAddress(signer),
  };
}
