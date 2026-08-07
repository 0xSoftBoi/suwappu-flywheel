/**
 * Grid Trading Strategy V2 — Dynamic ATR-based levels + Trailing take-profit.
 *
 * 1. ATR sets grid spacing (adapts to volatility)
 * 2. When price hits a level, trailing mode activates (rides momentum)
 * 3. Sells when price drops callback% from peak (locks in gains above target)
 * 4. After all levels sell, grid resets for next cycle
 */

import { log, formatUsd, logJson } from "../utils.js";
import { getDCAHistory, isConfirmedDCAHistory, type HistoryEntry } from "./dca.js";
import type { FlywheelState } from "../brain/state.js";
import { recordTrade } from "../brain/state.js";
import { getCandles, calcATRPct, dynamicGridLevels } from "../indicators.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  getUnaccountedExecution,
  markExecutionAccounted,
  runManagedExecution,
  type ExecutionIntent,
} from "../execution.js";

function stateDir(): string {
  return process.env.SUWAPPU_FLYWHEEL_STATE_DIR ?? join(homedir(), ".suwappu-flywheel");
}

function gridFile(): string {
  return join(stateDir(), "grid-state.json");
}

interface GridLevel {
  pctAboveEntry: number;
  sellPct: number;
  triggered: boolean;
  triggerPrice?: number;
  swapId?: string;
  txHash?: string;
  timestamp?: string;
  // Trailing take-profit
  trailingActive: boolean;
  highWatermark: number;
  callbackPct: number;    // e.g. 0.015 = 1.5% callback from peak
  activatedAt?: string;
}

interface GridState {
  avgEntryPrice: number;
  totalEthHeld: number;
  totalUsdcSpent: number;
  lastATRPct: number;
  levels: GridLevel[];
  sells: Array<{
    timestamp: string;
    price: number;
    ethSold: number;
    usdcReceived: number;
    swapId: string;
    txHash?: string;
    intentId?: string;
    executionStatus?: "completed" | "confirmed";
    profit?: number;
    level: number;
  }>;
  totalProfit: number;
}

function defaultGrid(): GridState {
  return {
    avgEntryPrice: 0,
    totalEthHeld: 0,
    totalUsdcSpent: 0,
    lastATRPct: 2.0,
    levels: buildLevels(2.0), // default 2% ATR
    sells: [],
    totalProfit: 0,
  };
}

function buildLevels(atrPct: number): GridLevel[] {
  const [l1, l2, l3] = dynamicGridLevels(atrPct);
  return [
    { pctAboveEntry: l1, sellPct: 0.25, triggered: false, trailingActive: false, highWatermark: 0, callbackPct: 0.015 },
    { pctAboveEntry: l2, sellPct: 0.25, triggered: false, trailingActive: false, highWatermark: 0, callbackPct: 0.020 },
    { pctAboveEntry: l3, sellPct: 0.50, triggered: false, trailingActive: false, highWatermark: 0, callbackPct: 0.025 },
  ];
}

function loadGrid(): GridState {
  try {
    if (existsSync(gridFile())) {
      const g = JSON.parse(readFileSync(gridFile(), "utf-8")) as GridState;
      // Ensure new fields exist (backward compat)
      if (g.lastATRPct === undefined) g.lastATRPct = 2.0;
      for (const level of g.levels) {
        if (level.trailingActive === undefined) level.trailingActive = false;
        if (level.highWatermark === undefined) level.highWatermark = 0;
        if (level.callbackPct === undefined) level.callbackPct = 0.015;
      }
      // Older Flywheel versions wrote sells at submission time. They cannot be
      // trusted as fills, so only explicitly reconciled rows feed accounting.
      g.sells = (g.sells ?? []).filter((sell) => (
        sell.executionStatus === "completed" || sell.executionStatus === "confirmed"
      ));
      g.totalProfit = g.sells.reduce((sum, sell) => sum + (sell.profit ?? 0), 0);
      return g;
    }
  } catch {}
  return defaultGrid();
}

function saveGrid(state: GridState) {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(gridFile(), JSON.stringify(state, null, 2));
}

function saveGridAndAcknowledgeExecutions(state: GridState) {
  // Persist strategy accounting before marking the execution journal consumed.
  // A crash can then replay safely instead of losing a confirmed fill.
  saveGrid(state);
  for (const sell of state.sells) {
    if (sell.intentId && sell.executionStatus === "completed") {
      markExecutionAccounted(sell.intentId);
    }
  }
}

/** Sync grid state with DCA history */
export function isGridInventoryHistory(entry: HistoryEntry): boolean {
  return isConfirmedDCAHistory(entry)
    && entry.token.toUpperCase() === "ETH"
    && entry.chain.toLowerCase() === "base";
}

function syncWithDCA(grid: GridState): GridState {
  const history = getDCAHistory().filter(isGridInventoryHistory);
  if (history.length === 0) {
    grid.totalUsdcSpent = 0;
    grid.totalEthHeld = 0;
    grid.avgEntryPrice = 0;
    return grid;
  }

  let totalSpent = 0;
  let totalEthBought = 0;
  for (const entry of history) {
    totalSpent += parseFloat(entry.amount);
    totalEthBought += parseFloat(entry.toAmount);
  }

  let totalEthSold = 0;
  for (const sell of grid.sells) {
    totalEthSold += sell.ethSold;
  }

  grid.totalUsdcSpent = totalSpent;
  grid.totalEthHeld = Math.max(totalEthBought - totalEthSold, 0);
  // Average unit cost does not rise merely because some units were sold.
  grid.avgEntryPrice = totalEthBought > 0 ? totalSpent / totalEthBought : 0;

  return grid;
}

/** Update grid levels based on current ATR */
async function updateDynamicLevels(grid: GridState): Promise<void> {
  try {
    const candles = await getCandles("ETHUSDC", "4h", 15);
    const atrPct = calcATRPct(candles);

    // Only update if ATR changed significantly (>0.3%)
    if (Math.abs(atrPct - grid.lastATRPct) > 0.3) {
      const [l1, l2, l3] = dynamicGridLevels(atrPct);
      // Only update untriggered levels
      if (!grid.levels[0].triggered && !grid.levels[0].trailingActive) grid.levels[0].pctAboveEntry = l1;
      if (!grid.levels[1].triggered && !grid.levels[1].trailingActive) grid.levels[1].pctAboveEntry = l2;
      if (!grid.levels[2].triggered && !grid.levels[2].trailingActive) grid.levels[2].pctAboveEntry = l3;
      grid.lastATRPct = atrPct;
    }
  } catch {
    // Binance unavailable — keep existing levels
  }
}

async function getGridSellQuote(apiKey: string, amount: string): Promise<{ id: string; toAmount: string }> {
  const quoteRes = await fetch("https://api.suwappu.bot/v1/agent/quote", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from_token: "ETH", to_token: "USDC", amount, chain: "base" }),
  });
  const quote = await quoteRes.json() as {
    quote_id?: string;
    amount_out?: string;
    error?: string;
    message?: string;
  };
  if (!quoteRes.ok || !quote.quote_id || !quote.amount_out) {
    throw new Error(quote.error ?? quote.message ?? `Grid quote failed (${quoteRes.status})`);
  }
  return { id: quote.quote_id, toAmount: quote.amount_out };
}

function finalizeGridSell(
  grid: GridState,
  levelIdx: number,
  intent: ExecutionIntent,
  brainState?: FlywheelState,
): boolean {
  if (intent.phase !== "completed" || !intent.swapId || !intent.actualFromAmount || !intent.actualToAmount) {
    return false;
  }
  if (grid.sells.some((sell) => sell.intentId === intent.id || sell.swapId === intent.swapId)) {
    return true;
  }

  const ethSold = parseFloat(intent.actualFromAmount);
  const usdcReceived = parseFloat(intent.actualToAmount);
  if (!Number.isFinite(ethSold) || ethSold <= 0 || !Number.isFinite(usdcReceived) || usdcReceived < 0) {
    return false;
  }

  const level = grid.levels[levelIdx];
  const avgEntryAtDecision = typeof intent.context?.avgEntryPrice === "number"
    ? intent.context.avgEntryPrice
    : grid.avgEntryPrice;
  const referencePrice = typeof intent.context?.referencePrice === "number"
    ? intent.context.referencePrice
    : (ethSold > 0 ? usdcReceived / ethSold : 0);
  const fillPrice = ethSold > 0 ? usdcReceived / ethSold : referencePrice;
  const profit = usdcReceived - ethSold * avgEntryAtDecision;
  const timestamp = new Date().toISOString();

  level.triggered = true;
  level.trailingActive = false;
  level.triggerPrice = referencePrice;
  level.swapId = intent.swapId;
  level.txHash = intent.txHash;
  level.timestamp = timestamp;

  grid.sells.push({
    timestamp,
    price: fillPrice,
    ethSold,
    usdcReceived,
    swapId: intent.swapId,
    txHash: intent.txHash,
    intentId: intent.id,
    executionStatus: "completed",
    profit,
    level: levelIdx,
  });
  grid.totalProfit += profit;
  grid.totalEthHeld = Math.max(0, grid.totalEthHeld - ethSold);

  if (brainState && !brainState.trades.some((trade) => trade.intentId === intent.id)) {
    recordTrade(brainState, {
      timestamp,
      strategy: "grid_sell",
      token: "ETH",
      chain: "base",
      amountIn: ethSold,
      amountOut: usdcReceived,
      // For a sell record, priceAtEntry is the USD cost basis per ETH. The
      // realized fill price is preserved in grid.sells[].price.
      priceAtEntry: avgEntryAtDecision,
      fearIndex: 0,
      txHash: intent.txHash,
      intentId: intent.id,
      swapId: intent.swapId,
    });
  }

  return true;
}

/** Check grid levels with trailing take-profit logic */
export async function checkGrid(opts: {
  execute?: boolean;
  json?: boolean;
  brainState?: FlywheelState;
}): Promise<{
  currentPrice: number;
  avgEntry: number;
  pnlPct: number;
  levelsToTrigger: number[];
  totalProfit: number;
}> {
  const apiKey = process.env.SUWAPPU_API_KEY ?? "";
  const execute = opts.execute ?? false;

  // Get current ETH price
  const priceRes = await fetch("https://api.suwappu.bot/v1/agent/prices?symbols=ETH", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const priceData = await priceRes.json() as { prices?: Record<string, { usd: number }> };
  const currentPrice = priceData.prices?.ETH?.usd ?? 0;

  let grid = loadGrid();
  grid = syncWithDCA(grid);
  await updateDynamicLevels(grid);

  // Resume durable intents before evaluating new price triggers. A submitted
  // level is never eligible for a second sell merely because price moved while
  // the first swap was pending or the prior HTTP outcome was unknown.
  const blockedLevels = new Set<number>();
  if (execute) {
    for (let i = 0; i < grid.levels.length; i++) {
      const pending = getUnaccountedExecution("grid", `level.${i}`);
      if (!pending) continue;
      blockedLevels.add(i);
      try {
        const receipt = await runManagedExecution({
          apiKey,
          strategy: "grid",
          actionKey: `level.${i}`,
          terms: pending.terms,
          getQuote: () => getGridSellQuote(apiKey, pending.terms.amount),
          walletAddress: process.env.SUWAPPU_MANAGED_WALLET_ADDRESS,
        });
        if (finalizeGridSell(grid, i, receipt.intent, opts.brainState)) {
          if (!opts.json) log("grid", `  CONFIRMED prior level ${i + 1} swap ${receipt.intent.swapId}`);
        } else if (receipt.intent.phase === "failed") {
          markExecutionAccounted(receipt.intent.id);
          if (!opts.json) log("grid", `  Prior level ${i + 1} was not executed: ${receipt.intent.error ?? "failed"}`);
        } else if (receipt.intent.phase === "completed") {
          if (!opts.json) log("grid", `  Level ${i + 1} completed, but final amounts are unavailable; accounting remains on hold`);
        } else if (!opts.json) {
          log("grid", `  Level ${i + 1} intent ${receipt.intent.id} is ${receipt.intent.phase}; waiting for final status`);
        }
      } catch (error) {
        if (!opts.json) log("grid", `  Level ${i + 1} reconciliation deferred: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (grid.avgEntryPrice === 0 || grid.totalEthHeld <= 0) {
    if (!opts.json) log("grid", "No positions to manage. Run DCA first.");
    saveGridAndAcknowledgeExecutions(grid);
    return { currentPrice, avgEntry: 0, pnlPct: 0, levelsToTrigger: [], totalProfit: grid.totalProfit };
  }

  const pnlPct = ((currentPrice - grid.avgEntryPrice) / grid.avgEntryPrice) * 100;

  if (!opts.json) {
    log("grid", `ETH: ${formatUsd(currentPrice)} | Entry: ${formatUsd(grid.avgEntryPrice)} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);
    log("grid", `Holdings: ${grid.totalEthHeld.toFixed(6)} ETH (~${formatUsd(grid.totalEthHeld * currentPrice)}) | ATR: ${grid.lastATRPct.toFixed(1)}%`);
  }

  const levelsToSell: number[] = [];

  for (let i = 0; i < grid.levels.length; i++) {
    const level = grid.levels[i];
    if (level.triggered || blockedLevels.has(i)) continue;

    const triggerPrice = grid.avgEntryPrice * (1 + level.pctAboveEntry);
    const pctLabel = `+${(level.pctAboveEntry * 100).toFixed(1)}%`;

    if (level.trailingActive) {
      // Trailing mode — update high watermark, check callback
      if (currentPrice > level.highWatermark) {
        level.highWatermark = currentPrice;
      }
      const callbackPrice = level.highWatermark * (1 - level.callbackPct);
      const callbackLabel = `${(level.callbackPct * 100).toFixed(1)}%`;

      if (currentPrice <= callbackPrice) {
        // Callback triggered — SELL
        levelsToSell.push(i);
        if (!opts.json) {
          log("grid", `🎯 Level ${pctLabel} TRAILING SELL! Peak ${formatUsd(level.highWatermark)} → callback ${callbackLabel} → sell at ${formatUsd(currentPrice)}`);
        }
      } else {
        // Still trailing
        const gainFromEntry = ((currentPrice - grid.avgEntryPrice) / grid.avgEntryPrice * 100).toFixed(1);
        if (!opts.json) {
          log("grid", `  Level ${pctLabel}: TRAILING 📈 peak ${formatUsd(level.highWatermark)} | callback at ${formatUsd(callbackPrice)} | +${gainFromEntry}% from entry`);
        }
      }
    } else if (currentPrice >= triggerPrice) {
      // Price hit level — activate trailing
      level.trailingActive = true;
      level.highWatermark = currentPrice;
      level.activatedAt = new Date().toISOString();
      if (!opts.json) {
        log("grid", `🔔 Level ${pctLabel} ACTIVATED! Trailing with ${(level.callbackPct * 100).toFixed(1)}% callback from ${formatUsd(currentPrice)}`);
      }

      // Safety: if trailing timeout >24h, force sell on next check
      // (handled below)
    } else {
      const dist = ((triggerPrice - currentPrice) / currentPrice * 100).toFixed(1);
      if (!opts.json) {
        log("grid", `  Level ${pctLabel}: ${formatUsd(triggerPrice)} (${dist}% away) — sell ${(level.sellPct * 100).toFixed(0)}%`);
      }
    }

    // Trailing timeout: if active >24h, force sell
    if (level.trailingActive && level.activatedAt) {
      const activeMs = Date.now() - new Date(level.activatedAt).getTime();
      if (activeMs > 24 * 60 * 60 * 1000 && !levelsToSell.includes(i)) {
        levelsToSell.push(i);
        if (!opts.json) log("grid", `⏰ Level ${pctLabel} trailing timeout (24h) — forcing sell`);
      }
    }
  }

  // Execute sells
  if (execute && levelsToSell.length > 0) {
    for (const levelIdx of levelsToSell) {
      const level = grid.levels[levelIdx];
      const ethToSell = grid.totalEthHeld * level.sellPct;
      const ethToSellStr = ethToSell.toFixed(6);

      if (ethToSell < 0.0001) {
        if (!opts.json) log("grid", `  Skipping — amount too small (${ethToSellStr} ETH)`);
        continue;
      }

      if (!opts.json) log("grid", `Selling ${ethToSellStr} ETH → USDC...`);

      try {
        const receipt = await runManagedExecution({
          apiKey,
          strategy: "grid",
          actionKey: `level.${levelIdx}`,
          terms: { fromToken: "ETH", toToken: "USDC", amount: ethToSellStr, chain: "base" },
          getQuote: () => getGridSellQuote(apiKey, ethToSellStr),
          walletAddress: process.env.SUWAPPU_MANAGED_WALLET_ADDRESS,
          context: { referencePrice: currentPrice, avgEntryPrice: grid.avgEntryPrice },
        });
        const intent = receipt.intent;

        if (finalizeGridSell(grid, levelIdx, intent, opts.brainState)) {
          if (!opts.json) {
            log("grid", `  CONFIRMED! ${intent.actualFromAmount} ETH → ${intent.actualToAmount} USDC | Swap ${intent.swapId}`);
            if (intent.txHash) log("grid", `  TX: ${intent.txHash}`);
          }
        } else if (intent.phase === "failed") {
          markExecutionAccounted(intent.id);
          if (!opts.json) log("grid", `  NOT EXECUTED: ${intent.error ?? intent.swapStatus ?? "failed"}`);
        } else if (intent.phase === "completed") {
          if (!opts.json) log("grid", "  COMPLETED, but final amounts are unavailable; holdings/P&L remain unchanged until reconciliation returns them.");
        } else if (!opts.json) {
          log("grid", `  SUBMITTED: intent ${intent.id}${intent.swapId ? ` | Swap ${intent.swapId}` : ""} (${intent.swapStatus ?? intent.phase})`);
          log("grid", "  Holdings and realized P&L are unchanged until reconciliation confirms the swap.");
        }
      } catch (e: any) {
        if (!opts.json) log("grid", `  Error: ${e.message}`);
      }
    }
  }

  // Auto-reset if all levels triggered
  const allTriggered = grid.levels.every(l => l.triggered);
  if (allTriggered) {
    if (!opts.json) log("grid", "All levels sold — resetting grid for new cycle");
    grid.levels = buildLevels(grid.lastATRPct);
  }

  saveGridAndAcknowledgeExecutions(grid);

  if (!opts.json) {
    log("grid", `Confirmed realized profit: ${formatUsd(grid.totalProfit)}`);
  }

  if (opts.json) {
    logJson({
      strategy: "grid",
      currentPrice,
      avgEntry: grid.avgEntryPrice,
      pnlPct,
      holdings: grid.totalEthHeld,
      atrPct: grid.lastATRPct,
      levelsTriggered: levelsToSell.length,
      totalProfit: grid.totalProfit,
    });
  }

  return { currentPrice, avgEntry: grid.avgEntryPrice, pnlPct, levelsToTrigger: levelsToSell, totalProfit: grid.totalProfit };
}

export function resetGrid() {
  const grid = loadGrid();
  grid.levels = buildLevels(grid.lastATRPct);
  saveGrid(grid);
  log("grid", "Grid levels reset for new cycle");
}
