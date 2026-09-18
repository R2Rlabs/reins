import { describe, expect, it } from "vitest";
import {
  approveBuilderFeeAction,
  approveBuilderFeeTypedData,
  checkSignedApproval,
  maxFeeRate,
  recoverApprover,
} from "./builder-approval.js";
import { otherTestWallet as other, signLikeAWallet, testWallet as wallet } from "./test-support/wallet.js";

const BUILDER = "0x658DC3a1fc753262c83c7345032E6DB7Aa8fA997";
const NOW = Date.UTC(2026, 8, 18, 19);

function action(overrides: Partial<Parameters<typeof approveBuilderFeeAction>[0]> = {}) {
  return approveBuilderFeeAction({
    builder: BUILDER,
    maxFeeTenthsBps: 20,
    network: "mainnet",
    signatureChainId: "0xa4b1",
    nonce: NOW,
    ...overrides,
  });
}

describe("maxFeeRate", () => {
  // The SDK's own example approves "0.001%" for orders sent with f: 1.
  it.each([
    [1, "0.001%"],
    [10, "0.01%"],
    [20, "0.02%"],
    [25, "0.025%"],
    [100, "0.1%"],
    [1_000, "1%"],
  ])("writes %i tenths of a bp as %s", (tenths, rate) => {
    expect(maxFeeRate(tenths)).toBe(rate);
  });

  it("refuses anything but a positive whole number of tenths", () => {
    expect(() => maxFeeRate(0)).toThrow();
    expect(() => maxFeeRate(1.5)).toThrow();
  });
});

describe("approveBuilderFeeAction", () => {
  it("builds the action Hyperliquid expects", () => {
    expect(action()).toEqual({
      type: "approveBuilderFee",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      maxFeeRate: "0.02%",
      builder: BUILDER.toLowerCase(),
      nonce: NOW,
    });
    expect(action({ network: "testnet" }).hyperliquidChain).toBe("Testnet");
  });

  it("refuses a builder that is not an address", () => {
    expect(() => action({ builder: "0x1234" })).toThrow(/not an address/);
  });

  it("signs over the user-signed domain at the wallet's chain id", () => {
    const typed = approveBuilderFeeTypedData(action());
    expect(typed.domain).toEqual({
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 42_161,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    });
    expect(typed.primaryType).toBe("HyperliquidTransaction:ApproveBuilderFee");
    expect(typed.types.EIP712Domain).toHaveLength(4);
  });
});

describe("recoverApprover", () => {
  it("recovers the wallet that signed", async () => {
    const a = action();
    expect(await recoverApprover(a, await signLikeAWallet(a))).toBe(wallet.address);
  });

  it("recovers someone else once any signed field changes", async () => {
    const a = action();
    const signature = await signLikeAWallet(a);
    expect(await recoverApprover({ ...a, maxFeeRate: "0.1%" }, signature)).not.toBe(wallet.address);
  });
});

describe("checkSignedApproval", () => {
  const expected = { builder: BUILDER, maxFeeRate: "0.02%", network: "mainnet" as const, now: NOW };

  async function submission(a = action(), signer = wallet, user: string = wallet.address) {
    return { action: a, signature: await signLikeAWallet(a, signer), user };
  }

  it("accepts a correct approval and splits the signature for the wire", async () => {
    const { request, user } = await checkSignedApproval(expected, await submission());
    expect(user).toBe(wallet.address);
    expect(request.nonce).toBe(NOW);
    expect(request.signature.r).toMatch(/^0x[0-9a-f]+$/);
    expect([27, 28]).toContain(request.signature.v);
  });

  it.each([
    ["another builder", { builder: other.address }, /names builder/],
    ["a higher rate", { maxFeeTenthsBps: 100 }, /is for 0.1%/],
    ["the other network", { network: "testnet" as const }, /is for Testnet/],
    ["a stale nonce", { nonce: NOW - 11 * 60_000 }, /not a current timestamp/],
  ])("refuses %s", async (_label, overrides, message) => {
    await expect(checkSignedApproval(expected, await submission(action(overrides)))).rejects.toThrow(message);
  });

  it("refuses a signature from a wallet other than the one claimed", async () => {
    await expect(
      checkSignedApproval(expected, await submission(action(), other, wallet.address)),
    ).rejects.toThrow(/signature is from/);
  });

  it("refuses junk", async () => {
    await expect(checkSignedApproval(expected, { action: null, signature: "0x", user: "x" })).rejects.toThrow();
    const good = await submission();
    await expect(checkSignedApproval(expected, { ...good, signature: "0x1234" })).rejects.toThrow(/65-byte/);
    await expect(checkSignedApproval(expected, { ...good, user: "nobody" })).rejects.toThrow(/which wallet/);
  });
});
