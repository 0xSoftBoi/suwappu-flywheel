/**
 * Persistent state for the self-improving flywheel agent.
 * Single source of truth — loaded at startup, saved after every run cycle.
 */
import { join } from "path";
import { homedir } from "os";
import { readJsonFile, writeJsonAtomic } from "../storage.js";

const STATE_DIR = join(homedir(), ".suwappu-flywheel");

function configuredStateDir(): string {
  return process.env.SUWAPPU_FLYWHEEL_STATE_DIR ?? STATE_DIR;
}

function configuredStateFile(): string {
  return join(configuredStateDir(), "state.json");
}

function configuredDcaHistoryFile(): string {
  return join(configuredStateDir(), "dca-history.json");
}

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
  intentId?: string;
  swapId?: string;
  // Backfilled later:
  priceAfter15m?: number;
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
  version: 2;
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
    peakValueAt?: string;
    maxDrawdownObserved: number;
    /** Last 30 evaluated trade-return observations (legacy field name). */
    rollingReturns30d: number[];
  };
}

export function defaultState(): FlywheelState {
  return {
    version: 2,
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
      maxDrawdownObserved: 0,
      rollingReturns30d: [],
    },
  };
}

function isStateShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const state = value as { trades?: unknown; portfolio?: unknown };
  return Array.isArray(state.trades) && !!state.portfolio && typeof state.portfolio === "object";
}

export function loadState(): FlywheelState {
  const state = readJsonFile(
    configuredStateFile(),
    defaultState,
    isStateShape,
  ) as FlywheelState & { version: number; portfolio: FlywheelState["portfolio"] };

  // Backward-compatible migration from v1 state. Existing files are upgraded
  // in memory and written on the next normal save; corrupt files fail closed.
  state.version = 2;
  if (!state.portfolio.startingCapital) state.portfolio.startingCapital = 50;
  if (state.portfolio.usdcBalance === undefined) state.portfolio.usdcBalance = 0;
  if (state.portfolio.ethBalance === undefined) state.portfolio.ethBalance = 0;
  if (state.portfolio.maxDrawdownObserved === undefined) {
    const peak = state.portfolio.peakValue ?? 0;
    const current = state.portfolio.currentValue ?? 0;
    state.portfolio.maxDrawdownObserved = peak > 0 ? Math.max(0, (peak - current) / peak) : 0;
  }
  if (!Array.isArray(state.portfolio.rollingReturns30d)) state.portfolio.rollingReturns30d = [];
  return state;
}

export function saveState(state: FlywheelState): void {
  state.lastRun = new Date().toISOString();
  writeJsonAtomic(configuredStateFile(), state);
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

  // Update portfolio tracking. A DCA buy does not have a strategy return at
  // fill time; its evaluated return is added only after a later price is
  // observed by backfillRewards().
  if (trade.strategy === "dca") {
    state.portfolio.totalInvested += trade.amountIn;
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
  const history = readJsonFile(configuredDcaHistoryFile(), () => [], Array.isArray) as Array<{
      timestamp: string;
      token: string;
      amount: string;
      price: number;
      toAmount: string;
      chain: string;
      fearIndex?: number;
      executionStatus?: string;
      intentId?: string;
      swapId?: string;
      txHash?: string;
    }>;

    // Build set of existing trade timestamps to avoid duplicates
    const existingTimestamps = new Set(
      state.trades
        .filter(t => t.strategy === "dca")
        .map(t => t.timestamp)
    );

    for (const entry of history) {
      // Before the execution journal existed, DCA history was written as soon
      // as a submission was accepted. Those legacy rows cannot prove a fill.
      if (entry.executionStatus !== "completed" && entry.executionStatus !== "confirmed") continue;

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
        intentId: entry.intentId,
        swapId: entry.swapId,
        txHash: entry.txHash,
      });

      state.portfolio.totalInvested += parseFloat(entry.amount);
      synced++;
    }
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
    state.portfolio.peakValueAt = new Date().toISOString();
  }
  const peak = state.portfolio.peakValue;
  const drawdown = peak > 0 ? Math.max(0, (peak - state.portfolio.currentValue) / peak) : 0;
  state.portfolio.maxDrawdownObserved = Math.max(state.portfolio.maxDrawdownObserved, drawdown);
}
