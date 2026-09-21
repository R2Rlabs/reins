/**
 * Reins' builder fee: part of the product, not a setting.
 *
 * Every live mainnet order carries it, and live trading does not start until
 * the account has approved it. Paper trading charges nothing but shows the
 * fee in its results, so a paper run says what live trading would cost.
 * Testnet carries none: it moves no real money, and the builder address holds
 * nothing there.
 */

/**
 * Where the fee is paid: a plain wallet address on Hyperliquid, which must
 * hold at least 100 USDC in its perps account, in Manual (standard) mode,
 * for orders carrying the fee to be accepted.
 */
export const REINS_BUILDER_ADDRESS = "0x658DC3a1fc753262c83c7345032E6DB7Aa8fA997";

/** 2 bp, in the tenths of a basis point Hyperliquid's `f` field uses. */
export const DEFAULT_BUILDER_FEE_TENTHS_BPS = 20;

export const REINS_BUILDER = {
  address: REINS_BUILDER_ADDRESS,
  feeTenthsBps: DEFAULT_BUILDER_FEE_TENTHS_BPS,
} as const;

/**
 * Why live trading cannot start for `account`, or undefined when it can.
 * Hyperliquid itself refuses an order carrying a builder fee the account has
 * not approved; this says so before the first order, with the way to fix it.
 */
export async function feeApprovalProblem(
  client: { maxBuilderFee(user: string, builder: string): Promise<number> },
  account: string,
): Promise<string | undefined> {
  const approved = await client.maxBuilderFee(account, REINS_BUILDER.address);
  if (approved >= REINS_BUILDER.feeTenthsBps) return undefined;
  return (
    `live trading needs Reins' ${REINS_BUILDER.feeTenthsBps / 10} bp builder fee approved for ` +
    `${account.toLowerCase()}, which has approved ${approved / 10} bp. Approve it once, from that ` +
    `account's own wallet: npx @r2rlabs/reins approve-builder`
  );
}
