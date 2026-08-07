import { describe, it, expect } from "bun:test";
import { fearMultiplier } from "../src/strategies/dca";
import { calculateSpreadPct, estimateArbNetUsd } from "../src/strategies/arb";
import { predictionPriceSumDeviation } from "../src/strategies/predict";

// ── Fear multiplier logic ──
describe("fear-adjusted DCA multiplier", () => {
  it("should 4x at extreme fear (0-10)", () => {
    expect(fearMultiplier(5)).toBe(4.0);
    expect(fearMultiplier(10)).toBe(4.0);
  });
  it("should 2x at fear (11-25)", () => {
    expect(fearMultiplier(20)).toBe(2.0);
  });
  it("should 1x at neutral (26-50)", () => {
    expect(fearMultiplier(40)).toBe(1.0);
  });
  it("should 0.5x at greed (51-75)", () => {
    expect(fearMultiplier(60)).toBe(0.5);
  });
  it("should 0.25x at extreme greed (76-100)", () => {
    expect(fearMultiplier(90)).toBe(0.25);
  });
  it("should calculate correct DCA amount", () => {
    const base = 5; // $5 base DCA
    expect(Math.round(base * fearMultiplier(10))).toBe(20); // 4x during extreme fear
    expect(Math.round(base * fearMultiplier(50))).toBe(5);  // 1x neutral
    expect(Math.round(base * fearMultiplier(90))).toBe(1);  // 0.25x greed
  });
});

// ── Arb spread calculation ──
describe("arb spread detection", () => {
  it("should calculate positive spread", () => {
    expect(calculateSpreadPct(2000, 2010)).toBeCloseTo(0.5, 1);
  });
  it("should find no spread at same price", () => {
    expect(calculateSpreadPct(2000, 2000)).toBe(0);
  });
  it("should detect sub-threshold spreads", () => {
    const spread = calculateSpreadPct(2000, 2001);
    expect(spread < 0.1).toBe(true); // Below 0.1% threshold
  });
  it("should detect a spread above the screening threshold", () => {
    const spread = calculateSpreadPct(2000, 2010);
    expect(spread >= 0.1).toBe(true);
  });
  it("keeps the cost-model estimate separate from raw spread", () => {
    // 1% gross on $1K = $10; Base→Arbitrum model cost $0.50 and 0.3% slippage $3.
    expect(estimateArbNetUsd(1000, 1, "base", "arbitrum")).toBeCloseTo(6.5, 6);
  });
});

// ── Yield sorting ──
describe("yield market sorting", () => {
  const markets = [
    { pair: "USDC/ETH", apy: 5.2 },
    { pair: "USDC/WBTC", apy: 12.5 },
    { pair: "DAI/ETH", apy: 3.1 },
  ];

  it("should sort by APY descending", () => {
    const sorted = [...markets].sort((a, b) => b.apy - a.apy);
    expect(sorted[0].apy).toBe(12.5);
    expect(sorted[2].apy).toBe(3.1);
  });

  it("should filter by minimum APY", () => {
    const filtered = markets.filter((m) => m.apy >= 5);
    expect(filtered.length).toBe(2);
  });

  it("should calculate yearly yield on $100", () => {
    const deposit = 100;
    const apy = 10;
    expect((deposit * apy) / 100).toBe(10); // $10/year
  });
});

// ── Prediction price-sum screening ──
describe("prediction market price-sum deviation", () => {
  it("should detect a deviation when sum < 1.0", () => {
    const yes = 0.45, no = 0.52;
    expect(predictionPriceSumDeviation(yes, no)).toBeGreaterThan(0.02);
  });

  it("should see no deviation when the sum is 1.0", () => {
    const yes = 0.65, no = 0.35;
    expect(predictionPriceSumDeviation(yes, no)).toBeLessThan(0.02);
  });

  it("should flag a sum above 1.0", () => {
    const yes = 0.55, no = 0.48;
    expect(yes + no).toBeGreaterThan(1.0);
  });
});

// ── Utility formatting ──
describe("formatting", () => {
  it("should format USD", () => {
    const n = 2847.32;
    const formatted = `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    expect(formatted).toContain("2,847.32");
  });

  it("should format percentage with sign", () => {
    expect(`+${(5.2).toFixed(2)}%`).toBe("+5.20%");
    expect(`${(-3.1).toFixed(2)}%`).toBe("-3.10%");
  });
});
