/**
 * Portfolio Manager — risk assessment, Kelly criterion sizing, strategy attribution.
 * Pure computation functions. No side effects, no API calls, no file I/O.
 */
import type { FlywheelState, TradeRecord } from "./brain/state.js";
import { fearMultiplier } from "./strategies/dca.js";
import { rsiMultiplier } from "./indicators.js";

// ── Constants ──
const MIN_KELLY_SAMPLES = 5;
const MAX_KELLY_FRACTION = 0.25;
const RISK_FREE_RATE = 0.05; // 5% annualized (stablecoin yield baseline)
const DAYS_PER_YEAR = 365;

// ── Types ──

export interface KellyResult {
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  kellyFraction: number;
  halfKelly: number;
  sampleSize: number;
  sufficient: boolean;
}

export interface StrategyKelly {
  dca: KellyResult | null;
  grid: KellyResult | null;
  arb: KellyResult | null;
  overall: KellyResult;
}

export interface RiskMetrics {
  rollingVolatility: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  valueAtRisk95: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  currentDrawdown: number;
}

export interface PositionAnalysis {
  token: string;
  costBasis: number;
  totalUnits: number;
  totalCost: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  holdingPeriodDays: number;
  concentrationPct: number;
}

export interface StrategyAttribution {
  strategy: string;
  tradeCount: number;
  scoredCount: number;
  winRate: number;
  totalPnL: number;
  avgReturn: number;
  bestTrade: number;
  worstTrade: number;
}

export interface SizingRecommendation {
  amount: number;
  kellyFraction: number;
  kellyCap: number;
  marketAdjustment: number;
  brainAdjustment: number;
  effectiveFraction: number;
  reasoning: string[];
  paused: boolean;
  pauseReason: string | null;
}

export interface PortfolioReport {
  timestamp: string;
  risk: RiskMetrics;
  positions: PositionAnalysis[];
  attribution: StrategyAttribution[];
  kelly: StrategyKelly;
  sizing: SizingRecommendation | null;
}

// ── Utility functions ──

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function downsideStdDev(arr: number[], threshold = 0): number {
  const downside = arr.filter((v) => v < threshold).map((v) => (v - threshold) ** 2);
  if (downside.length === 0) return 0;
  return Math.sqrt(downside.reduce((s, v) => s + v, 0) / arr.length); // divide by full length (not just downside)
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Raw P&L for a trade (not the composite reward score) */
function rawPnL(trade: TradeRecord): number {
  if (trade.strategy === "grid_sell") {
    // Sells: amountOut is USDC received, amountIn is ETH sold
    return trade.priceAtEntry > 0
      ? (trade.amountOut - trade.amountIn * trade.priceAtEntry) / (trade.amountIn * trade.priceAtEntry)
      : 0;
  }
  // Buys: amountIn is USDC spent, amountOut is ETH received
  return trade.priceAtEntry > 0
    ? (trade.amountOut * trade.priceAtEntry - trade.amountIn) / trade.amountIn
    : 0;
}

// ── Kelly Criterion ──

export function calculateKelly(
  trades: TradeRecord[],
  strategy?: "dca" | "arb" | "grid_sell"
): KellyResult {
  let scored = trades.filter((t) => t.reward !== undefined && t.priceAtEntry > 0);
  if (strategy) scored = scored.filter((t) => t.strategy === strategy);

  const result: KellyResult = {
    winRate: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    kellyFraction: 0,
    halfKelly: 0,
    sampleSize: scored.length,
    sufficient: scored.length >= MIN_KELLY_SAMPLES,
  };

  if (scored.length === 0) return result;

  const pnls = scored.map(rawPnL);
  const winners = pnls.filter((p) => p > 0);
  const losers = pnls.filter((p) => p <= 0);

  result.winRate = winners.length / pnls.length;
  result.avgWinPct = winners.length > 0 ? mean(winners) : 0;
  result.avgLossPct = losers.length > 0 ? Math.abs(mean(losers)) : 0;

  // Kelly: f = (W * avgWin - L * avgLoss) / avgWin
  if (result.avgWinPct > 0) {
    const f = (result.winRate * result.avgWinPct - (1 - result.winRate) * result.avgLossPct) / result.avgWinPct;
    result.kellyFraction = clamp(f, 0, 1);
  }
  result.halfKelly = Math.min(result.kellyFraction / 2, MAX_KELLY_FRACTION);

  return result;
}

export function calculateStrategyKelly(trades: TradeRecord[]): StrategyKelly {
  const dca = calculateKelly(trades, "dca");
  const grid = calculateKelly(trades, "grid_sell");
  const arb = calculateKelly(trades, "arb");
  const overall = calculateKelly(trades);
  return {
    dca: dca.sampleSize > 0 ? dca : null,
    grid: grid.sampleSize > 0 ? grid : null,
    arb: arb.sampleSize > 0 ? arb : null,
    overall,
  };
}

// ── Risk Metrics ──

export function calculateRiskMetrics(
  state: FlywheelState,
  currentValue: number
): RiskMetrics {
  const returns = state.portfolio.rollingReturns30d;
  const trades = state.trades;

  // Compute annualization factor from actual trade frequency
  let annualizationFactor = Math.sqrt(DAYS_PER_YEAR);
  if (trades.length >= 2) {
    const first = new Date(trades[0].timestamp).getTime();
    const last = new Date(trades[trades.length - 1].timestamp).getTime();
    const spanDays = Math.max(1, (last - first) / (1000 * 86400));
    const tradesPerDay = trades.length / spanDays;
    const tradesPerYear = tradesPerDay * DAYS_PER_YEAR;
    annualizationFactor = Math.sqrt(tradesPerYear);
  }

  const vol = stdDev(returns) * annualizationFactor;
  const meanRet = mean(returns);

  // Sharpe
  let sharpe = 0;
  if (returns.length >= 2 && stdDev(returns) > 0) {
    const annualizedMean = meanRet * (annualizationFactor ** 2 / DAYS_PER_YEAR) * DAYS_PER_YEAR;
    // Simpler: (meanReturn * tradesPerYear - Rf) / annualizedVol
    const tradesPerYear = trades.length >= 2
      ? trades.length / Math.max(1, (Date.now() - new Date(trades[0].timestamp).getTime()) / (1000 * 86400)) * DAYS_PER_YEAR
      : DAYS_PER_YEAR;
    sharpe = (meanRet * tradesPerYear - RISK_FREE_RATE) / vol;
    if (!isFinite(sharpe)) sharpe = 0;
  }

  // Sortino
  let sortino = 0;
  if (returns.length >= 2) {
    const dsd = downsideStdDev(returns, 0) * annualizationFactor;
    if (dsd > 0) {
      const tradesPerYear = trades.length >= 2
        ? trades.length / Math.max(1, (Date.now() - new Date(trades[0].timestamp).getTime()) / (1000 * 86400)) * DAYS_PER_YEAR
        : DAYS_PER_YEAR;
      sortino = (meanRet * tradesPerYear - RISK_FREE_RATE) / dsd;
      if (!isFinite(sortino)) sortino = 0;
    }
  }

  // Max drawdown
  const peak = state.portfolio.peakValue;
  const maxDD = peak > 0 ? Math.max(0, (peak - currentValue) / peak) : 0;
  const currentDD = maxDD;

  // Drawdown duration (days since peak)
  let ddDuration = 0;
  if (peak > 0 && currentValue < peak && trades.length > 0) {
    // Find when peak was reached (approximate from trades)
    const peakTrade = [...trades].reverse().find((t) =>
      t.priceAtEntry > 0 && new Date(t.timestamp).getTime() < Date.now()
    );
    if (peakTrade) {
      ddDuration = (Date.now() - new Date(trades[0].timestamp).getTime()) / (1000 * 86400);
    }
  }

  // Calmar
  let calmar = 0;
  if (maxDD > 0 && state.portfolio.startingCapital > 0) {
    const totalDays = trades.length >= 2
      ? (Date.now() - new Date(trades[0].timestamp).getTime()) / (1000 * 86400)
      : 1;
    const totalReturn = (currentValue / state.portfolio.startingCapital) - 1;
    const annualizedReturn = totalDays > 0
      ? ((1 + totalReturn) ** (DAYS_PER_YEAR / totalDays)) - 1
      : 0;
    calmar = annualizedReturn / maxDD;
    if (!isFinite(calmar)) calmar = 0;
  }

  // VaR (95%) — worst expected loss per trade at 95% confidence
  const sd = stdDev(returns);
  const var95 = returns.length >= 2
    ? Math.abs(currentValue * (meanRet - 1.645 * sd))
    : 0;

  return {
    rollingVolatility: vol,
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    calmarRatio: calmar,
    valueAtRisk95: var95,
    maxDrawdown: maxDD,
    maxDrawdownDuration: ddDuration,
    currentDrawdown: currentDD,
  };
}

// ── Position Analysis ──

export function analyzePositions(
  trades: TradeRecord[],
  prices: Record<string, number>,
  totalPortfolioValue: number
): PositionAnalysis[] {
  const tokenMap = new Map<string, { bought: number; cost: number; sold: number; firstBuy: string }>();

  for (const t of trades) {
    if (!tokenMap.has(t.token)) {
      tokenMap.set(t.token, { bought: 0, cost: 0, sold: 0, firstBuy: t.timestamp });
    }
    const pos = tokenMap.get(t.token)!;

    if (t.strategy === "grid_sell") {
      pos.sold += t.amountIn; // amountIn is ETH sold
    } else {
      pos.bought += t.amountOut; // amountOut is ETH received
      pos.cost += t.amountIn;   // amountIn is USDC spent
      if (new Date(t.timestamp) < new Date(pos.firstBuy)) {
        pos.firstBuy = t.timestamp;
      }
    }
  }

  const positions: PositionAnalysis[] = [];
  for (const [token, pos] of tokenMap) {
    const totalUnits = Math.max(0, pos.bought - pos.sold);
    const costBasis = pos.bought > 0 ? pos.cost / pos.bought : 0;
    const currentPrice = prices[token] ?? 0;
    const currentValue = totalUnits * currentPrice;
    const totalCostOfHeld = totalUnits * costBasis;
    const unrealizedPnL = currentValue - totalCostOfHeld;

    positions.push({
      token,
      costBasis,
      totalUnits,
      totalCost: totalCostOfHeld,
      currentPrice,
      currentValue,
      unrealizedPnL,
      unrealizedPnLPct: totalCostOfHeld > 0 ? (unrealizedPnL / totalCostOfHeld) * 100 : 0,
      holdingPeriodDays: (Date.now() - new Date(pos.firstBuy).getTime()) / (1000 * 86400),
      concentrationPct: totalPortfolioValue > 0 ? (currentValue / totalPortfolioValue) * 100 : 0,
    });
  }

  return positions.filter((p) => p.totalUnits > 0);
}

// ── Strategy Attribution ──

export function attributeStrategies(trades: TradeRecord[]): StrategyAttribution[] {
  const groups = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const key = t.strategy;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const result: StrategyAttribution[] = [];
  for (const [strategy, group] of groups) {
    const scored = group.filter((t) => t.reward !== undefined);
    const pnls = scored.map(rawPnL);
    const winners = scored.filter((t) => t.profitable === true);

    result.push({
      strategy,
      tradeCount: group.length,
      scoredCount: scored.length,
      winRate: scored.length > 0 ? winners.length / scored.length : 0,
      totalPnL: pnls.reduce((s, v) => s + v, 0),
      avgReturn: pnls.length > 0 ? mean(pnls) : 0,
      bestTrade: pnls.length > 0 ? Math.max(...pnls) : 0,
      worstTrade: pnls.length > 0 ? Math.min(...pnls) : 0,
    });
  }

  return result.sort((a, b) => b.totalPnL - a.totalPnL);
}

// ── Risk-Adjusted Sizing ──

export function getRecommendedSize(
  state: FlywheelState,
  usdcBalance: number,
  marketData: { fearValue: number; rsi: number; atrPct: number },
  baseAmount = 2
): SizingRecommendation {
  const reasoning: string[] = [];

  // Circuit breaker check
  if (state.adjustments.dcaAmountMultiplier === 0) {
    return {
      amount: 0,
      kellyFraction: 0,
      kellyCap: 0,
      marketAdjustment: 0,
      brainAdjustment: 0,
      effectiveFraction: 0,
      reasoning: ["DCA paused: drawdown circuit breaker active"],
      paused: true,
      pauseReason: "Drawdown exceeds limit",
    };
  }

  // Kelly sizing
  const kelly = calculateKelly(state.trades, "dca");
  let maxFraction: number;

  if (kelly.sufficient && kelly.halfKelly > 0) {
    maxFraction = kelly.halfKelly;
    reasoning.push(`Kelly: ${(kelly.winRate * 100).toFixed(0)}% win rate, half-Kelly = ${(maxFraction * 100).toFixed(1)}%`);
  } else {
    maxFraction = 0.05; // fallback 5%
    reasoning.push(`Kelly: insufficient data (${kelly.sampleSize}/${MIN_KELLY_SAMPLES} trades), using 5% cap`);
  }

  const kellyCap = usdcBalance > 0 ? Math.max(1, Math.floor(usdcBalance * maxFraction)) : 1;

  // Market multipliers
  const fearMult = fearMultiplier(marketData.fearValue);
  const rsiMult = rsiMultiplier(marketData.rsi);

  // ATR adjustment: high vol → smaller, low vol → slightly larger
  let atrAdj = 1.0;
  if (marketData.atrPct > 3) {
    atrAdj = 2.0 / marketData.atrPct;
    reasoning.push(`ATR ${marketData.atrPct.toFixed(1)}% (high vol) → ${atrAdj.toFixed(2)}x`);
  } else if (marketData.atrPct < 1) {
    atrAdj = 1.2;
    reasoning.push(`ATR ${marketData.atrPct.toFixed(1)}% (low vol) → 1.2x`);
  }

  const brainMult = state.adjustments.dcaAmountMultiplier;
  const marketAdj = fearMult * rsiMult * atrAdj;

  reasoning.push(`Fear ${marketData.fearValue}: ${fearMult}x | RSI ${marketData.rsi.toFixed(0)}: ${rsiMult}x | Brain: ${brainMult.toFixed(2)}x`);

  // Compute raw amount then cap with Kelly
  const rawAmount = Math.max(1, Math.round(baseAmount * marketAdj * brainMult));
  const amount = Math.min(rawAmount, kellyCap);

  if (rawAmount > kellyCap) {
    reasoning.push(`Capped $${rawAmount} → $${amount} (Kelly ${(maxFraction * 100).toFixed(0)}% of $${Math.floor(usdcBalance)})`);
  }

  const effectiveFraction = usdcBalance > 0 ? amount / usdcBalance : 0;
  reasoning.push(`Sizing: $${amount} (${(effectiveFraction * 100).toFixed(1)}% of balance)`);

  return {
    amount,
    kellyFraction: maxFraction,
    kellyCap,
    marketAdjustment: marketAdj,
    brainAdjustment: brainMult,
    effectiveFraction,
    reasoning,
    paused: false,
    pauseReason: null,
  };
}

// ── Full Report ──

export function generatePortfolioReport(
  state: FlywheelState,
  prices: Record<string, number>,
  totalPortfolioValue: number
): PortfolioReport {
  return {
    timestamp: new Date().toISOString(),
    risk: calculateRiskMetrics(state, totalPortfolioValue),
    positions: analyzePositions(state.trades, prices, totalPortfolioValue),
    attribution: attributeStrategies(state.trades),
    kelly: calculateStrategyKelly(state.trades),
    sizing: null,
  };
}

// ── CLI Formatter ──

export function formatPortfolioReport(
  report: PortfolioReport,
  sizing?: SizingRecommendation
): string[] {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════╗");
  lines.push("║       PORTFOLIO RISK ASSESSMENT          ║");
  lines.push("╚══════════════════════════════════════════╝");
  lines.push("");

  // Risk Metrics
  lines.push("── RISK METRICS ──");
  const r = report.risk;
  lines.push(`  Volatility (ann.)   ${(r.rollingVolatility * 100).toFixed(1)}%`);
  lines.push(`  Sharpe Ratio        ${r.sharpeRatio.toFixed(2)}`);
  lines.push(`  Sortino Ratio       ${r.sortinoRatio.toFixed(2)}`);
  lines.push(`  Calmar Ratio        ${r.calmarRatio.toFixed(2)}`);
  lines.push(`  VaR (95%, per trade) $${r.valueAtRisk95.toFixed(2)}`);
  lines.push(`  Max Drawdown        ${(r.maxDrawdown * 100).toFixed(1)}%`);
  lines.push(`  DD Duration         ${r.maxDrawdownDuration.toFixed(1)} days`);
  lines.push(`  Current Drawdown    ${(r.currentDrawdown * 100).toFixed(1)}%`);
  lines.push("");

  // Positions
  if (report.positions.length > 0) {
    lines.push("── POSITIONS ──");
    for (const p of report.positions) {
      const pnlSign = p.unrealizedPnL >= 0 ? "+" : "";
      lines.push(`  ${p.token}`);
      lines.push(`    Units: ${p.totalUnits.toFixed(6)} | Cost basis: $${p.costBasis.toFixed(2)}`);
      lines.push(`    Value: $${p.currentValue.toFixed(2)} @ $${p.currentPrice.toFixed(2)}`);
      lines.push(`    Unrealized P&L: ${pnlSign}$${p.unrealizedPnL.toFixed(2)} (${pnlSign}${p.unrealizedPnLPct.toFixed(1)}%)`);
      lines.push(`    Holding: ${p.holdingPeriodDays.toFixed(1)} days | Concentration: ${p.concentrationPct.toFixed(0)}%`);
    }
    lines.push("");
  }

  // Strategy Attribution
  if (report.attribution.length > 0) {
    lines.push("── STRATEGY ATTRIBUTION ──");
    lines.push(`  ${"Strategy".padEnd(12)} ${"Trades".padEnd(8)} ${"Win Rate".padEnd(10)} ${"Avg Ret".padEnd(10)} ${"Best".padEnd(10)} ${"Worst".padEnd(10)}`);
    lines.push(`  ${"─".repeat(62)}`);
    for (const a of report.attribution) {
      const wr = a.scoredCount > 0 ? `${(a.winRate * 100).toFixed(0)}%` : "—";
      const avg = a.scoredCount > 0 ? `${(a.avgReturn * 100).toFixed(2)}%` : "—";
      const best = a.scoredCount > 0 ? `${(a.bestTrade * 100).toFixed(2)}%` : "—";
      const worst = a.scoredCount > 0 ? `${(a.worstTrade * 100).toFixed(2)}%` : "—";
      lines.push(`  ${a.strategy.padEnd(12)} ${String(a.tradeCount).padEnd(8)} ${wr.padEnd(10)} ${avg.padEnd(10)} ${best.padEnd(10)} ${worst.padEnd(10)}`);
    }
    lines.push("");
  }

  // Kelly
  lines.push("── KELLY CRITERION ──");
  const k = report.kelly.overall;
  lines.push(`  Sample size:  ${k.sampleSize} trades ${k.sufficient ? "✓" : `(need ${MIN_KELLY_SAMPLES})`}`);
  lines.push(`  Win rate:     ${(k.winRate * 100).toFixed(0)}%`);
  lines.push(`  Avg win:      ${(k.avgWinPct * 100).toFixed(2)}%`);
  lines.push(`  Avg loss:     ${(k.avgLossPct * 100).toFixed(2)}%`);
  lines.push(`  Kelly f*:     ${(k.kellyFraction * 100).toFixed(1)}%`);
  lines.push(`  Half-Kelly:   ${(k.halfKelly * 100).toFixed(1)}%${k.kellyFraction === 0 ? " (no edge detected)" : ""}`);
  lines.push("");

  // Sizing
  if (sizing) {
    lines.push("── SIZING RECOMMENDATION ──");
    if (sizing.paused) {
      lines.push(`  ⚠ ${sizing.pauseReason}`);
    } else {
      lines.push(`  Recommended: $${sizing.amount}`);
      lines.push(`  Kelly cap:   $${sizing.kellyCap} (${(sizing.kellyFraction * 100).toFixed(1)}% of balance)`);
    }
    for (const r of sizing.reasoning) {
      lines.push(`  ${r}`);
    }
  }

  return lines;
}
