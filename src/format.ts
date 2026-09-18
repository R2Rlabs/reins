/**
 * Price and size formatting for Hyperliquid orders.
 *
 * Getting this wrong is one of the most common reasons an otherwise valid
 * order is rejected, so the rules are encoded here rather than left to the
 * caller:
 *
 * - Prices carry at most 5 significant figures, except integers, which are
 *   always allowed however long they are.
 * - Price decimals are capped at MAX_DECIMALS - szDecimals, where MAX_DECIMALS
 *   is 6 for perps and 8 for spot.
 * - Sizes are rounded to the asset's szDecimals.
 * - Trailing zeroes are stripped before signing.
 */

const MAX_DECIMALS_PERP = 6;
const MAX_DECIMALS_SPOT = 8;
const MAX_SIGNIFICANT_FIGURES = 5;

/** Fixed-point string with trailing zeroes removed, never exponential. */
function toPlainString(value: number, decimals: number): string {
  let out = value.toFixed(Math.max(0, decimals));
  if (out.includes(".")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  // toFixed renders -0 as "-0"; normalise it away.
  return out === "-0" ? "0" : out;
}

export function formatSize(size: number, szDecimals: number): string {
  if (!Number.isFinite(size)) {
    throw new RangeError(`Size must be a finite number, got ${size}.`);
  }
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new RangeError(`szDecimals must be a non-negative integer, got ${szDecimals}.`);
  }
  return toPlainString(size, szDecimals);
}

export function formatPrice(
  price: number,
  szDecimals: number,
  isSpot = false,
): string {
  if (!Number.isFinite(price) || price <= 0) {
    throw new RangeError(`Price must be a positive finite number, got ${price}.`);
  }
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new RangeError(`szDecimals must be a non-negative integer, got ${szDecimals}.`);
  }

  const maxDecimals = (isSpot ? MAX_DECIMALS_SPOT : MAX_DECIMALS_PERP) - szDecimals;

  // Integers bypass the significant-figure limit entirely, so a price that is
  // already whole goes through untouched.
  if (Number.isInteger(price)) return String(price);

  const rounded = Number(price.toPrecision(MAX_SIGNIFICANT_FIGURES));
  if (Number.isInteger(rounded)) return String(rounded);

  return toPlainString(rounded, Math.max(0, maxDecimals));
}
