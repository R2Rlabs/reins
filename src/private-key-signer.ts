import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { SignL1ActionInput, Signer } from "./signer.js";
import { actionHash, AGENT_TYPES, EXCHANGE_DOMAIN, phantomAgent, splitSignature } from "./signing.js";
import type { Signature } from "./types.js";

/**
 * A Signer backed by a private key.
 *
 * The key is handed to viem at construction and never stored on this object, so
 * it cannot be reached through the instance, printed by a stray log line, or
 * serialised into a decision record. `toJSON` is overridden for the same
 * reason: an object holding signing authority should be boring to inspect.
 */
export class PrivateKeySigner implements Signer {
  readonly address: string;
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: string) {
    const normalised = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
      // Deliberately does not echo the value back.
      throw new Error("Private key must be 32 bytes of hex, optionally 0x-prefixed.");
    }
    this.account = privateKeyToAccount(normalised as Hex);
    this.address = this.account.address.toLowerCase();
  }

  async signL1Action(input: SignL1ActionInput): Promise<Signature> {
    const hash = actionHash(input.action, input.nonce, input.vaultAddress);
    const signature = await this.account.signTypedData({
      domain: EXCHANGE_DOMAIN,
      types: AGENT_TYPES,
      primaryType: "Agent",
      message: phantomAgent(hash, !input.isTestnet),
    });
    return splitSignature(signature);
  }

  /** Keep key material out of anything that stringifies this object. */
  toJSON(): { address: string } {
    return { address: this.address };
  }
}
