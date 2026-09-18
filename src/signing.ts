import { encode } from "@msgpack/msgpack";
import { hexToBytes, keccak256, type Hex } from "viem";
import type { Signature } from "./types.js";

/**
 * The L1 action signing scheme, ported from Hyperliquid's Python SDK.
 *
 * Hyperliquid's docs say to use an existing SDK rather than generate these by
 * hand, and they are right about why: the action is msgpack-encoded, so **map
 * key order is part of the hash**. Reorder two fields in an action object and
 * the signature silently becomes invalid — the request is rejected with no clue
 * that ordering was the problem.
 *
 * The parts that are easy to get wrong, spelled out:
 *
 * - msgpack keys are serialised in insertion order, never sorted. Build action
 *   objects in the order the API documents them.
 * - The nonce is appended as 8 big-endian bytes after the packed action.
 * - A vault address contributes a 0x01 marker plus its 20 bytes; no vault
 *   contributes a single 0x00.
 * - `source` is "a" on mainnet and "b" on testnet. Using the wrong one produces
 *   a perfectly valid signature that the other network refuses.
 * - The EIP-712 domain is fixed: chainId 1337, a zero verifying contract. It is
 *   not the chain you are trading on.
 *
 * Every function here is pure and holds no key material, so the whole scheme is
 * verifiable against the reference implementation's published test vectors —
 * which `signing.test.ts` does.
 */

export const EXCHANGE_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

export const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

export interface PhantomAgent {
  source: "a" | "b";
  connectionId: Hex;
}

function bigEndian64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * keccak256(msgpack(action) ++ nonce ++ vault marker ++ optional expiry).
 */
export function actionHash(
  action: unknown,
  nonce: number,
  vaultAddress: string | null,
  expiresAfter?: number,
): Hex {
  // encode() can hand back a view over a larger buffer; copy so the bytes we
  // hash are exactly the encoded action and nothing after it.
  const packed = Uint8Array.from(encode(action));

  const chunks: Uint8Array[] = [packed, bigEndian64(nonce)];
  if (vaultAddress === null) {
    chunks.push(Uint8Array.of(0x00));
  } else {
    chunks.push(Uint8Array.of(0x01));
    chunks.push(hexToBytes(vaultAddress as Hex));
  }
  if (expiresAfter !== undefined) {
    chunks.push(Uint8Array.of(0x00));
    chunks.push(bigEndian64(expiresAfter));
  }

  return keccak256(concat(chunks));
}

export function phantomAgent(hash: Hex, isMainnet: boolean): PhantomAgent {
  return { source: isMainnet ? "a" : "b", connectionId: hash };
}

/** The EIP-712 payload an L1 action is signed over. */
export function l1Payload(agent: PhantomAgent) {
  return {
    domain: EXCHANGE_DOMAIN,
    types: AGENT_TYPES,
    primaryType: "Agent" as const,
    message: agent,
  };
}

function trimLeadingZeros(hex: string): string {
  const trimmed = hex.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

/**
 * Split a 65-byte signature into the `{r, s, v}` Hyperliquid expects.
 *
 * `r` and `s` are emitted as minimal hex with leading zeroes stripped, matching
 * the Python SDK's `to_hex(int)` output byte for byte. Zero-padded hex is the
 * same number and is very likely accepted too, but the reference format is the
 * only one there is published evidence for, and this cannot be checked against
 * the live exchange without a funded key.
 */
export function splitSignature(signature: Hex): Signature {
  const body = signature.slice(2);
  if (body.length !== 130) {
    throw new Error(`Expected a 65-byte signature, got ${body.length / 2} bytes.`);
  }
  const v = Number.parseInt(body.slice(128, 130), 16);
  return {
    r: `0x${trimLeadingZeros(body.slice(0, 64))}`,
    s: `0x${trimLeadingZeros(body.slice(64, 128))}`,
    // viem may report parity as 0/1; Hyperliquid wants 27/28.
    v: v < 27 ? v + 27 : v,
  };
}
