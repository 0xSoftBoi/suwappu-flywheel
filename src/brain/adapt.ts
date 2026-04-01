/**
 * Adaptive parameter tuning — the agent adjusts its own strategy
 * based on observed trade outcomes.
 *
 * Key principle: increase what works, decrease what doesn't, pause on drawdown.
 */
import type { FlywheelState } from "./state.js";
import { log } from "../utils.js";

export interface AdaptationResult {
  dcaMultiplierChange: string; // "increased", "decreased", "unchanged", "PAUSED"
  arbSpreadChange: string;
  reason: string;
}

export function adaptParameters(state: FlywheelState): AdaptationResult {
  const result: AdaptationResult = {
    dcaMultiplierChange: "unchanged",
    arbSpreadChange: "unchanged",
    reason: "not enough data",
  };

  const recentTrades = state.trades.slice(-20);
  if (recentTrades.length < 2) {
    return result; // Need minimum data to adapt
  }

  const scoredTrades = recentTrades.filter((t) => t.reward !== undefined);
  if (scoredTrades.length < 2) {
    result.reason = `only ${scoredTrades.length}/2 trades scored — waiting for backfill`;
    return result;
  }

  const rewards = scoredTrades.map((t) => t.reward!);
  const avgReward = rewards.reduce((s, r) => s + r, 0) / rewards.length;

  // 1. Adaptive DCA sizing
  const prevMult = state.adjustments.dcaAmountMultiplier;

  if (avgReward > 0.02) {
    // Strategy is profitable: increase position by 10%, cap at 2x
    state.adjustments.dcaAmountMultiplier = Math.min(2.0, prevMult * 1.1);
    result.dcaMultiplierChange = "increased";
    result.reason = `avg reward +${(avgReward * 100).toFixed(1)}% → scaling up`;
  } else if (avgReward < -0.02) {
    // Strategy is losing: decrease by 20%, floor at 0.25x
    state.adjustments.dcaAmountMultiplier = Math.max(0.25, prevMult * 0.8);
    result.dcaMultiplierChange = "decreased";
    result.reason = `avg reward ${(avgReward * 100).toFixed(1)}% → scaling down`;
  } else {
    result.reason = `avg reward ${(avgReward * 100).toFixed(1)}% → within neutral zone`;
  }

  // 2. Adaptive arb threshold
  const arbTrades = scoredTrades.filter((t) => t.strategy === "arb");
  if (arbTrades.length >= 3) {
    const hitRate = arbTrades.filter((t) => t.profitable).length / arbTrades.length;
    state.beliefs.arbHitRate7d = hitRate;

    if (hitRate < 0.3) {
      state.adjustments.minArbSpread = Math.min(2.0, state.adjustments.minArbSpread * 1.2);
      result.arbSpreadChange = "increased";
    } else if (hitRate > 0.7) {
      state.adjustments.minArbSpread = Math.max(0.1, state.adjustments.minArbSpread * 0.9);
      result.arbSpreadChange = "decreased";
    }
  }

  // 3. Drawdown circuit breaker
  const { peakValue, currentValue } = state.portfolio;
  if (peakValue > 0) {
    const drawdown = (peakValue - currentValue) / peakValue;

    if (drawdown > state.adjustments.maxDrawdownPause) {
      state.adjustments.dcaAmountMultiplier = 0;
      result.dcaMultiplierChange = "PAUSED";
      result.reason = `drawdown ${(drawdown * 100).toFixed(1)}% exceeds ${(state.adjustments.maxDrawdownPause * 100).toFixed(0)}% limit — DCA PAUSED`;
    } else if (prevMult === 0 && drawdown < state.adjustments.maxDrawdownPause * 0.5) {
      // Resume if drawdown recovered to half the pause level
      state.adjustments.dcaAmountMultiplier = 0.5; // Resume at 50%
      result.dcaMultiplierChange = "resumed";
      result.reason = `drawdown recovered to ${(drawdown * 100).toFixed(1)}% — resuming at 0.5x`;
    }
  }

  return result;
}

/**
 * Log the current agent state in a human-readable format.
 */
export function logAgentState(state: FlywheelState): void {
  const { adjustments, beliefs, portfolio, trades } = state;

  log("brain", "Agent State:");
  log("brain", `  Trades: ${trades.length} total, ${trades.filter((t) => t.reward !== undefined).length} scored`);
  log("brain", `  DCA multiplier: ${adjustments.dcaAmountMultiplier.toFixed(2)}x`);
  log("brain", `  Arb min spread: ${adjustments.minArbSpread.toFixed(2)}%`);
  log("brain", `  Portfolio: $${portfolio.totalInvested.toFixed(2)} invested, peak $${portfolio.peakValue.toFixed(2)}`);

  if (adjustments.dcaAmountMultiplier === 0) {
    log("brain", "  ⚠️  DCA is PAUSED (drawdown circuit breaker)");
  }

  const vaultEntries = Object.entries(beliefs.vaults);
  if (vaultEntries.length > 0) {
    log("brain", "  Vault beliefs:");
    for (const [vault, { alpha, beta }] of vaultEntries) {
      const mean = (alpha / (alpha + beta) * 100).toFixed(0);
      log("brain", `    ${vault}: ${mean}% confidence (α=${alpha}, β=${beta})`);
    }
  }
}
