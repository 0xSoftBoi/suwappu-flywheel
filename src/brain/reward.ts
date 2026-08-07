/**
 * Trade scoring — Adaptive Risk Control reward function.
 * Composite: 0.4*profit + 0.3*sharpe - 0.3*drawdown
 */
import type { TradeRecord, FlywheelState } from "./state.js";

/**
 * Observed strategy return. Buys require a later market observation; their
 * entry-price quote discrepancy is execution cost, not a subsequent return.
 */
export function observedReturnPct(trade: TradeRecord): number | undefined {
  if (trade.strategy === "grid_sell") {
    const costBasis = trade.amountIn * trade.priceAtEntry;
    return costBasis > 0 ? (trade.amountOut - costBasis) / costBasis : undefined;
  }

  const observedPrice = trade.priceAfter24h ?? trade.priceAfter1h ?? trade.priceAfter15m;
  if (observedPrice === undefined || trade.amountIn <= 0) return undefined;
  return (trade.amountOut * observedPrice - trade.amountIn) / trade.amountIn;
}

export function scoreTradeReward(
  trade: TradeRecord,
  currentPrice: number,
  state: FlywheelState
): number {
  // Keep both sides in USD. Grid amountIn is ETH; DCA amountIn is USDC.
  const entryValue = trade.strategy === "grid_sell"
    ? trade.amountIn * trade.priceAtEntry
    : trade.amountIn;
  const currentValue = trade.strategy === "grid_sell"
    ? trade.amountOut // grid sells already return USDC
    : trade.amountOut * currentPrice; // buys: ETH * price = USD value
  const pnlPct = entryValue > 0 ? (currentValue - entryValue) / entryValue : 0;

  // Rolling Sharpe contribution
  const returns = state.portfolio.rollingReturns30d;
  let sharpeContrib = 0;
  if (returns.length >= 3) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    sharpeContrib = std > 0 ? (mean / std) * Math.sqrt(365) : 0;
    sharpeContrib = Math.min(Math.max(sharpeContrib, -3), 3); // cap both directions
  }

  // Drawdown penalty
  const peak = state.portfolio.peakValue;
  const current = state.portfolio.currentValue;
  const drawdown = peak > 0 ? Math.max(0, (peak - current) / peak) : 0;

  return 0.4 * pnlPct + 0.3 * sharpeContrib - 0.3 * drawdown;
}

/**
 * Backfill trade outcomes — score trades from previous runs using current prices.
 */
export async function backfillRewards(
  state: FlywheelState,
  getCurrentPrice: (token: string) => Promise<number>
): Promise<number> {
  let updated = 0;

  for (const trade of state.trades) {
    const ageMs = Date.now() - new Date(trade.timestamp).getTime();
    if (ageMs < 15 * 60 * 1000) continue;

    try {
      let evaluationPrice = trade.priceAtEntry;
      if (trade.strategy !== "grid_sell") {
        const needs24h = ageMs >= 24 * 60 * 60 * 1000 && trade.priceAfter24h === undefined;
        const needs1h = ageMs >= 60 * 60 * 1000 && ageMs < 24 * 60 * 60 * 1000
          && trade.priceAfter1h === undefined;
        const needs15m = ageMs < 60 * 60 * 1000 && trade.priceAfter15m === undefined;

        if (!needs24h && !needs1h && !needs15m) {
          const existingPrice = trade.priceAfter24h ?? trade.priceAfter1h ?? trade.priceAfter15m;
          if (trade.reward !== undefined || existingPrice === undefined) continue;
          evaluationPrice = existingPrice;
        } else {
          const currentPrice = await getCurrentPrice(trade.token);
          if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;
          if (needs24h) trade.priceAfter24h = currentPrice;
          else if (needs1h) trade.priceAfter1h = currentPrice;
          else if (needs15m) trade.priceAfter15m = currentPrice;
          evaluationPrice = currentPrice;
        }
      } else if (trade.reward !== undefined) {
        continue;
      }

      trade.reward = scoreTradeReward(trade, evaluationPrice, state);
      const observedReturn = observedReturnPct(trade);
      trade.profitable = observedReturn === undefined ? undefined : observedReturn > 0;

      updated++;
    } catch {
      // Can't get price — skip
    }
  }

  // The legacy field name is retained for state compatibility, but the values
  // are rebuilt from actual evaluated outcomes rather than quote-time marks.
  state.portfolio.rollingReturns30d = state.trades
    .map((trade) => ({
      timestamp: new Date(trade.timestamp).getTime(),
      value: observedReturnPct(trade),
    }))
    .filter((entry): entry is { timestamp: number; value: number } => (
      Number.isFinite(entry.timestamp)
      && entry.value !== undefined
      && Number.isFinite(entry.value)
    ))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-30)
    .map((entry) => entry.value);

  return updated;
}
