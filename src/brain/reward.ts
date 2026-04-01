/**
 * Trade scoring — Adaptive Risk Control reward function.
 * Composite: 0.4*profit + 0.3*sharpe - 0.3*drawdown
 */
import type { TradeRecord, FlywheelState } from "./state.js";

export function scoreTradeReward(
  trade: TradeRecord,
  currentPrice: number,
  state: FlywheelState
): number {
  // P&L: amountOut is tokens (ETH), convert to USD with current price
  const entryValue = trade.amountIn; // USDC spent
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
  let scored = 0;

  for (const trade of state.trades) {
    if (trade.reward !== undefined) continue;

    const ageMs = Date.now() - new Date(trade.timestamp).getTime();
    if (ageMs < 15 * 60 * 1000) continue; // Score trades >15min old (faster feedback loop)

    try {
      const currentPrice = await getCurrentPrice(trade.token);

      if (!trade.priceAfter1h && ageMs >= 60 * 60 * 1000) {
        trade.priceAfter1h = currentPrice;
      }
      if (!trade.priceAfter24h && ageMs >= 24 * 60 * 60 * 1000) {
        trade.priceAfter24h = currentPrice;
      }

      trade.reward = scoreTradeReward(trade, currentPrice, state);
      trade.profitable = trade.strategy === "grid_sell"
        ? true // sells are always "profitable" in that they lock in gains
        : (trade.amountOut * currentPrice) > trade.amountIn;

      scored++;
    } catch {
      // Can't get price — skip
    }
  }

  return scored;
}
