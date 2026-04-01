/**
 * Persistent state for the self-improving flywheel agent.
 * Single source of truth — loaded at startup, saved after every run cycle.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = join(homedir(), ".suwappu-flywheel");
const STATE_FILE = join(STATE_DIR, "state.json");
const DCA_HISTORY_FILE = join(STATE_DIR, "dca-history.json");

export interface TradeRecord {
  id: string;
  timestamp: string;
  strategy: "dca" | "arb" | "yield" | "grid_sell";
  token: string;
  chain: string;
  amountIn: number;    // USDC spent (for buys) or ETH sold (for sells)
  amountOut: number;   // ETH received (for buys) or USDC received (for sells)
  priceAtEntry: number;
  fearIndex: number;
  dayOfWeek: string;
  txHash?: string;
  // Backfilled later:
  priceAfter1h?: number;
  priceAfter24h?: number;
  reward?: number;
  profitable?: boolean;
}

export interface VaultBelief {
  alpha: number;
  beta: number;
}

export interface FlywheelState {
  version: 1;
  lastRun: string;
  trades: TradeRecord[];
  beliefs: {
    vaults: Record<string, VaultBelief>;
    fearMultiplierEff: number;
    arbHitRate7d: number;
  };
  adjustments: {
    dcaAmountMultiplier: number;
    minArbSpread: number;
    maxDrawdownPause: number;
    yieldRotationEnabled: boolean;
  };
  portfolio: {
    startingCapital: number;
    totalInvested: number;
    usdcBalance: number;
    ethBalance: number;
    currentValue: number;
    peakValue: number;
    rollingReturns30d: number[];
  };
}

export function defaultState(): FlywheelState {
  return {
    version: 1,
    lastRun: new Date().toISOString(),
    trades: [],
    beliefs: {
      vaults: {},
      fearMultiplierEff: 1.0,
      arbHitRate7d: 0,
    },
    adjustments: {
      dcaAmountMultiplier: 1.0,
      minArbSpread: 0.5,
      maxDrawdownPause: 0.25,
      yieldRotationEnabled: true,
    },
    portfolio: {
      startingCapital: 50,
      totalInvested: 0,
      usdcBalance: 0,
      ethBalance: 0,
      currentValue: 0,
      peakValue: 0,
      rollingReturns30d: [],
    },
  };
}

export function loadState(): FlywheelState {
  try {
    if (existsSync(STATE_FILE)) {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as FlywheelState;
      // Ensure new fields exist (backward compat)
      if (!state.portfolio.startingCapital) state.portfolio.startingCapital = 50;
      if (state.portfolio.usdcBalance === undefined) state.portfolio.usdcBalance = 0;
      if (state.portfolio.ethBalance === undefined) state.portfolio.ethBalance = 0;
      return state;
    }
  } catch {}
  return defaultState();
}

export function saveState(state: FlywheelState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function recordTrade(
  state: FlywheelState,
  trade: Omit<TradeRecord, "id" | "dayOfWeek">
): TradeRecord {
  const record: TradeRecord = {
    ...trade,
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    dayOfWeek: new Date().toLocaleDateString("en-US", { weekday: "long" }),
  };
  state.trades.push(record);

  // Update portfolio tracking
  if (trade.strategy === "dca") {
    state.portfolio.totalInvested += trade.amountIn;
    // PnL: how much USD value we got vs what we paid
    const returnPct = trade.priceAtEntry > 0
      ? (trade.amountOut * trade.priceAtEntry - trade.amountIn) / trade.amountIn
      : 0;
    state.portfolio.rollingReturns30d.push(returnPct);
  } else if (trade.strategy === "grid_sell") {
    // Sells return USDC — amountOut is USDC received
    const returnPct = trade.amountIn > 0
      ? (trade.amountOut - trade.amountIn * trade.priceAtEntry) / (trade.amountIn * trade.priceAtEntry)
      : 0;
    state.portfolio.rollingReturns30d.push(returnPct);
  }

  if (state.portfolio.rollingReturns30d.length > 30) {
    state.portfolio.rollingReturns30d.shift();
  }

  return record;
}

/**
 * Sync brain state with DCA history file.
 * DCA history is the source of truth for buy trades.
 * Brain state may be missing trades if it wasn't updated during previous DCA runs.
 */
export function syncFromDCAHistory(state: FlywheelState): number {
  let synced = 0;
  try {
    if (!existsSync(DCA_HISTORY_FILE)) return 0;
    const history = JSON.parse(readFileSync(DCA_HISTORY_FILE, "utf-8")) as Array<{
      timestamp: string;
      token: string;
      amount: string;
      price: number;
      toAmount: string;
      chain: string;
      fearIndex?: number;
    }>;

    // Build set of existing trade timestamps to avoid duplicates
    const existingTimestamps = new Set(
      state.trades
        .filter(t => t.strategy === "dca")
        .map(t => t.timestamp)
    );

    for (const entry of history) {
      // Skip if already in brain state (match by timestamp)
      if (existingTimestamps.has(entry.timestamp)) continue;

      // Also skip near-matches (within 5 seconds)
      const entryTime = new Date(entry.timestamp).getTime();
      const isNearDuplicate = state.trades.some(t => {
        if (t.strategy !== "dca") return false;
        return Math.abs(new Date(t.timestamp).getTime() - entryTime) < 5000;
      });
      if (isNearDuplicate) continue;

      // Add missing trade
      state.trades.push({
        id: `t_sync_${entryTime}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: entry.timestamp,
        strategy: "dca",
        token: entry.token,
        chain: entry.chain,
        amountIn: parseFloat(entry.amount),
        amountOut: parseFloat(entry.toAmount),
        priceAtEntry: entry.price,
        fearIndex: entry.fearIndex ?? 50,
        dayOfWeek: new Date(entry.timestamp).toLocaleDateString("en-US", { weekday: "long" }),
      });

      state.portfolio.totalInvested += parseFloat(entry.amount);
      synced++;
    }
  } catch {}
  return synced;
}

/**
 * Update portfolio values from on-chain balances and current price.
 */
export function updatePortfolio(
  state: FlywheelState,
  usdcBalance: number,
  ethBalance: number,
  ethPrice: number
): void {
  state.portfolio.usdcBalance = usdcBalance;
  state.portfolio.ethBalance = ethBalance;
  state.portfolio.currentValue = usdcBalance + ethBalance * ethPrice;
  if (state.portfolio.currentValue > state.portfolio.peakValue) {
    state.portfolio.peakValue = state.portfolio.currentValue;
  }
}
