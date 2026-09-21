import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { DEFAULT_BUILDER_FEE_TENTHS_BPS, REINS_BUILDER, REINS_BUILDER_ADDRESS, feeApprovalProblem } from "./builder-fee.js";

const ACCOUNT = "0xA8639caC43F0BF6049014F27B0d93dAa547F5d32";
const approving = (tenths: number) => ({
  asked: [] as [string, string][],
  async maxBuilderFee(user: string, builder: string) {
    this.asked.push([user, builder]);
    return tenths;
  },
});

describe("Reins' builder fee", () => {
  it("is 2 bp to a checksummed address", () => {
    expect(DEFAULT_BUILDER_FEE_TENTHS_BPS).toBe(20);
    expect(getAddress(REINS_BUILDER_ADDRESS)).toBe(REINS_BUILDER_ADDRESS);
    expect(REINS_BUILDER).toEqual({ address: REINS_BUILDER_ADDRESS, feeTenthsBps: 20 });
  });

  it("lets live trading start once the account has approved it", async () => {
    const client = approving(20);
    expect(await feeApprovalProblem(client, ACCOUNT)).toBeUndefined();
    expect(client.asked).toEqual([[ACCOUNT, REINS_BUILDER_ADDRESS]]);
    expect(await feeApprovalProblem(approving(100), ACCOUNT)).toBeUndefined();
  });

  it("stops it, and says how to approve, when the account has not", async () => {
    const problem = await feeApprovalProblem(approving(0), ACCOUNT);
    expect(problem).toMatch(/needs Reins' 2 bp builder fee approved for 0xa8639c/);
    expect(problem).toMatch(/approved 0 bp/);
    expect(problem).toMatch(/npx @r2rlabs\/reins approve-builder/);
    expect(await feeApprovalProblem(approving(10), ACCOUNT)).toMatch(/approved 1 bp/);
  });
});
