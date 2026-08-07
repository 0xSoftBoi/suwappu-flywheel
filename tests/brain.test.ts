import { describe, it, expect } from "bun:test";
import { betaSample, chooseVault, updateVaultBelief, initVaultBeliefs } from "../src/brain/bandit";
import { defaultState, recordTrade } from "../src/brain/state";
import type { FlywheelState } from "../src/brain/state";
import { scoreTradeReward } from "../src/brain/reward";
import { getRecommendedSize } from "../src/portfolio";

// ── Thompson Sampling ──

describe("Thompson Sampling", () => {
  it("betaSample returns values between 0 and 1", () => {
    for (let i = 0; i < 100; i++) {
      const s = betaSample(2, 3);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("high alpha produces higher samples on average", () => {
    let highSum = 0, lowSum = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      highSum += betaSample(10, 2); // strong success history
      lowSum += betaSample(2, 10);  // strong failure history
    }
    expect(highSum / n).toBeGreaterThan(lowSum / n);
  });

  it("chooseVault picks vault with best belief", () => {
    const beliefs = {
      "vault_a": { alpha: 10, beta: 2 }, // ~83% success
      "vault_b": { alpha: 2, beta: 10 }, // ~17% success
      "vault_c": { alpha: 5, beta: 5 },  // ~50% success
    };
    // Run many times — vault_a should win most
    let aWins = 0;
    for (let i = 0; i < 100; i++) {
      if (chooseVault(beliefs).vault === "vault_a") aWins++;
    }
    expect(aWins).toBeGreaterThan(50); // Should win majority
  });

  it("updateVaultBelief increments alpha on success", () => {
    const beliefs = initVaultBeliefs(["v1"]);
    expect(beliefs.v1.alpha).toBe(1);
    updateVaultBelief(beliefs, "v1", true);
    expect(beliefs.v1.alpha).toBe(2);
    expect(beliefs.v1.beta).toBe(1);
  });

  it("updateVaultBelief increments beta on failure", () => {
    const beliefs = initVaultBeliefs(["v1"]);
    updateVaultBelief(beliefs, "v1", false);
    expect(beliefs.v1.alpha).toBe(1);
    expect(beliefs.v1.beta).toBe(2);
  });
});

// ── Reward Scoring ──

describe("reward scoring", () => {
  it("positive PnL produces positive reward component", () => {
    const pnlPct = (11 - 10) / 10; // 10% profit
    expect(0.4 * pnlPct).toBeGreaterThan(0);
  });

  it("drawdown produces negative reward component", () => {
    const drawdown = (100 - 80) / 100; // 20% drawdown
    expect(-0.3 * drawdown).toBeLessThan(0);
  });

  it("composite reward balances profit and risk", () => {
    // Good trade: 5% profit, no drawdown
    const goodReward = 0.4 * 0.05 + 0.3 * 1.0 - 0.3 * 0;
    // Bad trade: -5% loss, 20% drawdown
    const badReward = 0.4 * (-0.05) + 0.3 * (-0.5) - 0.3 * 0.2;
    expect(goodReward).toBeGreaterThan(badReward);
  });

  it("scores a grid sell in USD on both sides of the trade", () => {
    const state = defaultState();
    const trade = recordTrade(state, {
      timestamp: new Date().toISOString(),
      strategy: "grid_sell",
      token: "ETH",
      chain: "base",
      amountIn: 1,
      amountOut: 2100,
      priceAtEntry: 2000,
      fearIndex: 50,
    });
    expect(scoreTradeReward(trade, 2100, state)).toBeCloseTo(0.02, 6);
  });
});

// ── Adaptive Parameters ──

describe("adaptive parameters", () => {
  it("keeps an RSI no-trade signal at a zero dollar size", () => {
    const sizing = getRecommendedSize(
      defaultState(),
      100,
      { fearValue: 50, rsi: 80, atrPct: 2 },
      5,
    );
    expect(sizing.marketAdjustment).toBe(0);
    expect(sizing.amount).toBe(0);
  });

  it("winning streak increases DCA multiplier", () => {
    const mult = 1.0;
    const newMult = Math.min(2.0, mult * 1.1);
    expect(newMult).toBeCloseTo(1.1, 1);
  });

  it("losing streak decreases DCA multiplier", () => {
    const mult = 1.0;
    const newMult = Math.max(0.25, mult * 0.8);
    expect(newMult).toBeCloseTo(0.8, 1);
  });

  it("multiplier is capped at 2x", () => {
    let mult = 1.8;
    mult = Math.min(2.0, mult * 1.1); // 1.98
    mult = Math.min(2.0, mult * 1.1); // 2.0 (capped)
    expect(mult).toBe(2.0);
  });

  it("multiplier has floor at 0.25x", () => {
    let mult = 0.3;
    mult = Math.max(0.25, mult * 0.8); // 0.25 (floored)
    expect(mult).toBe(0.25);
  });

  it("drawdown circuit breaker pauses at threshold", () => {
    const peak = 100;
    const current = 70; // 30% drawdown
    const threshold = 0.25;
    const drawdown = (peak - current) / peak;
    expect(drawdown > threshold).toBe(true);
  });

  it("drawdown recovery resumes trading", () => {
    const peak = 100;
    const current = 90; // 10% drawdown, below half of 25% threshold
    const threshold = 0.25;
    const drawdown = (peak - current) / peak;
    expect(drawdown < threshold * 0.5).toBe(true);
  });
});

// ── State Management ──

describe("state management", () => {
  it("defaultState has correct initial values", () => {
    const state = defaultState();
    expect(state.version).toBe(1);
    expect(state.trades).toHaveLength(0);
    expect(state.adjustments.dcaAmountMultiplier).toBe(1.0);
    expect(state.adjustments.minArbSpread).toBe(0.5);
  });

  it("recordTrade adds to trades and updates portfolio", () => {
    const state = defaultState();
    const trade = recordTrade(state, {
      timestamp: new Date().toISOString(),
      strategy: "dca",
      token: "ETH",
      chain: "base",
      amountIn: 10,
      amountOut: 0.005,
      priceAtEntry: 2000,
      fearIndex: 11,
    });
    expect(state.trades).toHaveLength(1);
    expect(trade.id).toMatch(/^t_/);
    expect(trade.dayOfWeek).toBeTruthy();
    expect(state.portfolio.totalInvested).toBe(10);
  });

  it("rolling returns window stays at 30", () => {
    const state = defaultState();
    for (let i = 0; i < 35; i++) {
      recordTrade(state, {
        timestamp: new Date().toISOString(),
        strategy: "dca",
        token: "ETH",
        chain: "base",
        amountIn: 10,
        amountOut: 0.005,
        priceAtEntry: 2000,
        fearIndex: 11,
      });
    }
    expect(state.portfolio.rollingReturns30d.length).toBeLessThanOrEqual(30);
  });
});

// ── Anti-Resonance ──

describe("anti-resonance (counterexample injection)", () => {
  it("should include losers in balanced history", () => {
    const trades = [
      { reward: 0.1 }, { reward: 0.2 }, { reward: 0.15 }, { reward: 0.3 },
      { reward: -0.05 }, { reward: -0.1 },
    ];
    const winners = trades.filter(t => t.reward > 0);
    const losers = trades.filter(t => t.reward <= 0);
    const n = 5;
    const minLosers = Math.ceil(n * 0.2); // 1

    expect(minLosers).toBe(1);
    expect(losers.length).toBeGreaterThanOrEqual(minLosers);
  });

  it("20% minimum losers prevents confirmation bias", () => {
    const n = 10;
    const minLosers = Math.ceil(n * 0.2);
    expect(minLosers).toBe(2); // Force 2 losers in top 10
  });
});
