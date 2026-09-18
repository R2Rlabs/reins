import { describe, expect, it } from "vitest";
import { formatPrice, formatSize } from "./format.js";

describe("formatSize", () => {
  it("rounds to the asset's szDecimals", () => {
    expect(formatSize(1.00012, 3)).toBe("1");
    expect(formatSize(1.2345, 3)).toBe("1.234");
    expect(formatSize(0.0335, 4)).toBe("0.0335");
  });

  it("strips trailing zeroes", () => {
    expect(formatSize(1.5, 5)).toBe("1.5");
    expect(formatSize(2, 5)).toBe("2");
  });

  it("handles a whole-unit asset", () => {
    expect(formatSize(7.8, 0)).toBe("8");
  });

  it("never emits negative zero", () => {
    expect(formatSize(-0.0001, 2)).toBe("0");
  });

  it("rejects a non-finite size", () => {
    expect(() => formatSize(NaN, 3)).toThrow(RangeError);
  });
});

describe("formatPrice", () => {
  it("passes integers through however long they are", () => {
    // Integers are exempt from the five-significant-figure rule.
    expect(formatPrice(123456, 5)).toBe("123456");
    expect(formatPrice(50000, 5)).toBe("50000");
  });

  it("rounds to five significant figures", () => {
    expect(formatPrice(1234.567, 1)).toBe("1234.6");
    // Six significant figures in, five out.
    expect(formatPrice(1.23456, 1)).toBe("1.2346");
  });

  it("caps decimals at MAX_DECIMALS minus szDecimals", () => {
    // szDecimals 5 on a perp leaves one decimal place, which binds well
    // before the significant-figure limit does.
    expect(formatPrice(1.23456, 5)).toBe("1.2");
    expect(formatPrice(1.29, 5)).toBe("1.3");
  });

  it("applies whichever of the two limits is tighter", () => {
    // 0.0012345678 rounds to 0.0012346 on significant figures alone, but a
    // perp with szDecimals 1 allows only five decimal places, so that wins.
    expect(formatPrice(0.0012345678, 1)).toBe("0.00123");
    // Spot allows eight decimals minus szDecimals, so the same price keeps
    // all five of its significant figures.
    expect(formatPrice(0.0012345678, 1, true)).toBe("0.0012346");
  });

  it("strips trailing zeroes", () => {
    expect(formatPrice(1.2000001, 1)).toBe("1.2");
  });

  it("returns a plain string, never exponential notation", () => {
    expect(formatPrice(0.00000123456, 1)).not.toContain("e");
  });

  it("rejects a zero or negative price", () => {
    expect(() => formatPrice(0, 3)).toThrow(RangeError);
    expect(() => formatPrice(-1, 3)).toThrow(RangeError);
  });
});
