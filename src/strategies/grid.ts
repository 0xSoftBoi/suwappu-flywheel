/**
 * Grid Trading Strategy V2 — Dynamic ATR-based levels + Trailing take-profit.
 *
 * 1. ATR sets grid spacing (adapts to volatility)
 * 2. When price hits a level, trailing mode activates (rides momentum)
 * 3. Sells when price drops callback% from peak (locks in gains above target)
 * 4. After all levels sell, grid resets for next cycle
 */

import { log, formatUsd, logJson } from "../utils.js";
import { getDCAHistory } from "./dca.js";
import type { FlywheelState } from "../brain/state.js";
import { recordTrade } from "../brain/state.js";
import { getCandles, calcATRPct, dynamicGridLevels } from "../indicators.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = join(homedir(), ".suwappu-flywheel");
const GRID_FILE = join(STATE_DIR, "grid-state.json");

interface GridLevel {
  pctAboveEntry: number;
  sellPct: number;
  triggered: boolean;
  triggerPrice?: number;
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
    txHash: string;
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
    if (existsSync(GRID_FILE)) {
      const g = JSON.parse(readFileSync(GRID_FILE, "utf-8")) as GridState;
      // Ensure new fields exist (backward compat)
      if (g.lastATRPct === undefined) g.lastATRPct = 2.0;
      for (const level of g.levels) {
        if (level.trailingActive === undefined) level.trailingActive = false;
        if (level.highWatermark === undefined) level.highWatermark = 0;
        if (level.callbackPct === undefined) level.callbackPct = 0.015;
      }
      return g;
    }
  } catch {}
  return defaultGrid();
}

function saveGrid(state: GridState) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(GRID_FILE, JSON.stringify(state, null, 2));
}

/** Sync grid state with DCA history */
function syncWithDCA(grid: GridState): GridState {
  const history = getDCAHistory();
  if (history.length === 0) return grid;

  let totalSpent = 0;
  let totalEth = 0;
  for (const entry of history) {
    totalSpent += parseFloat(entry.amount);
    totalEth += parseFloat(entry.toAmount);
  }

  for (const sell of grid.sells) {
    totalEth -= sell.ethSold;
  }

  grid.totalUsdcSpent = totalSpent;
  grid.totalEthHeld = Math.max(totalEth, 0);
  grid.avgEntryPrice = totalEth > 0 ? totalSpent / totalEth : 0;

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

  if (grid.avgEntryPrice === 0 || grid.totalEthHeld <= 0) {
    if (!opts.json) log("grid", "No positions to manage. Run DCA first.");
    saveGrid(grid);
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
    if (level.triggered) continue;

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
        const quoteRes = await fetch("https://api.suwappu.bot/v1/agent/quote", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from_token: "ETH", to_token: "USDC", amount: ethToSellStr, chain: "base" }),
        });
        const quote = await quoteRes.json() as { quote_id?: string; amount_out?: string; success?: boolean };

        if (!quote.quote_id) {
          if (!opts.json) log("grid", `  Quote failed: ${JSON.stringify(quote)}`);
          continue;
        }

        const swapRes = await fetch("https://api.suwappu.bot/v1/agent/swap/sign-and-send", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ quote_id: quote.quote_id }),
        });
        const swap = await swapRes.json() as { tx_hash?: string; success?: boolean; error?: string };

        if (swap.success && swap.tx_hash) {
          const usdcReceived = parseFloat(quote.amount_out ?? "0");
          const costBasis = ethToSell * grid.avgEntryPrice;
          const profit = usdcReceived - costBasis;

          level.triggered = true;
          level.trailingActive = false;
          level.triggerPrice = currentPrice;
          level.txHash = swap.tx_hash;
          level.timestamp = new Date().toISOString();

          grid.sells.push({
            timestamp: new Date().toISOString(),
            price: currentPrice,
            ethSold: ethToSell,
            usdcReceived,
            txHash: swap.tx_hash!,
            level: levelIdx,
          });

          grid.totalProfit += profit;
          grid.totalEthHeld -= ethToSell;

          if (opts.brainState) {
            recordTrade(opts.brainState, {
              timestamp: new Date().toISOString(),
              strategy: "grid_sell",
              token: "ETH",
              chain: "base",
              amountIn: ethToSell,
              amountOut: usdcReceived,
              priceAtEntry: currentPrice,
              fearIndex: 0,
              txHash: swap.tx_hash,
            });
          }

          if (!opts.json) {
            log("grid", `  SOLD! ${ethToSellStr} ETH → ${usdcReceived.toFixed(2)} USDC | Profit: ${formatUsd(profit)}`);
            log("grid", `  TX: ${swap.tx_hash}`);
          }
        } else {
          if (!opts.json) log("grid", `  Sell failed: ${swap.error}`);
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

  saveGrid(grid);

  if (!opts.json) {
    log("grid", `Total realized profit: ${formatUsd(grid.totalProfit)}`);
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
