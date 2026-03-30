import { describe, it, expect } from "bun:test";

// ── Fear multiplier logic ──
function fearMultiplier(value: number): number {
  if (value <= 10) return 4.0;
  if (value <= 25) return 2.0;
  if (value <= 50) return 1.0;
  if (value <= 75) return 0.5;
  return 0.25;
}

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
function calculateSpread(buyPrice: number, sellPrice: number): number {
  return ((sellPrice - buyPrice) / buyPrice) * 100;
}

describe("arb spread detection", () => {
  it("should calculate positive spread", () => {
    expect(calculateSpread(2000, 2010)).toBeCloseTo(0.5, 1);
  });
  it("should find no spread at same price", () => {
    expect(calculateSpread(2000, 2000)).toBe(0);
  });
  it("should detect sub-threshold spreads", () => {
    const spread = calculateSpread(2000, 2001);
    expect(spread < 0.1).toBe(true); // Below 0.1% threshold
  });
  it("should detect profitable spread", () => {
    const spread = calculateSpread(2000, 2010);
    expect(spread >= 0.1).toBe(true);
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

// ── Prediction mispricing ──
describe("prediction market mispricing", () => {
  it("should detect mispriced market (sum < 1.0)", () => {
    const yes = 0.45, no = 0.52;
    const sum = yes + no;
    expect(Math.abs(sum - 1.0)).toBeGreaterThan(0.02);
  });

  it("should accept efficient market (sum ≈ 1.0)", () => {
    const yes = 0.65, no = 0.35;
    expect(Math.abs(yes + no - 1.0)).toBeLessThan(0.02);
  });

  it("should flag overpriced market (sum > 1.0)", () => {
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
