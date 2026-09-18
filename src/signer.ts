import type { Signature } from "./types.js";

/**
 * Signing is deliberately behind an interface.
 *
 * Hyperliquid's own docs say to use an existing SDK rather than generating
 * signatures by hand — L1 actions are msgpack-hashed into a phantom agent and
 * then signed EIP-712, and the field order matters. Hand-rolling it is a
 * well-known source of silent, hard-to-debug rejections.
 *
 * So the client takes a Signer and never implements one. The real
 * implementation wraps a known-good library; tests use StubSigner.
 */
export interface SignL1ActionInput {
  action: unknown;
  nonce: number;
  vaultAddress: string | null;
  isTestnet: boolean;
}

export interface Signer {
  /** The account these signatures are for, lowercased hex. */
  readonly address: string;
  signL1Action(input: SignL1ActionInput): Promise<Signature>;
}

/**
 * A signer that produces a deterministic fake signature and records what it
 * was asked to sign. Useful in tests and in paper-trading mode, where nothing
 * is ever submitted to a real exchange.
 */
export class StubSigner implements Signer {
  readonly address: string;
  readonly signed: SignL1ActionInput[] = [];

  constructor(address = "0x000000000000000000000000000000000000dead") {
    this.address = address.toLowerCase();
  }

  async signL1Action(input: SignL1ActionInput): Promise<Signature> {
    this.signed.push(input);
    return {
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
      v: 27,
    };
  }
}
