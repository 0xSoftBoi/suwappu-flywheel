#!/usr/bin/env bun

// Auto-load .env from project root (works when run globally via bun link)
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "..", ".env");
try {
  const envFile = await Bun.file(envPath).text();
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

import { Command } from "commander";
import { createClient } from "@suwappu/sdk";
import { requireEnv, log } from "./utils.js";
import { scanYield } from "./strategies/yield.js";
import { executeDCA, getFearIndex, fearMultiplier } from "./strategies/dca.js";
import { scanArb } from "./strategies/arb.js";
import { scanPredictions } from "./strategies/predict.js";
import { checkGrid, resetGrid } from "./strategies/grid.js";
import { loadState, saveState, recordTrade, syncFromDCAHistory, updatePortfolio } from "./brain/state.js";
import { getUSDCBalance, getETHBalance } from "./strategies/dca.js";
import { getCandles, calcRSI, rsiMultiplier, calcATRPct } from "./indicators.js";
import { backfillRewards } from "./brain/reward.js";
import { adaptParameters, logAgentState } from "./brain/adapt.js";
import { generatePortfolioReport, getRecommendedSize, formatPortfolioReport } from "./portfolio.js";

function getClient() {
  return createClient({ apiKey: requireEnv("SUWAPPU_API_KEY") });
}

const program = new Command()
  .name("suwappu-flywheel")
  .description("Self-sustaining multi-strategy DeFi agent — $50 minimum, $0 API cost")
  .version("1.0.0");

// ── Yield ──
program.command("yield").description("Scan lending markets for best APY")
  .option("--chain <id>", "chain ID", parseInt, 8453)
  .option("--top <n>", "show top N markets", parseInt, 10)
  .option("--min-apy <n>", "minimum APY filter", parseFloat, 0)
  .option("--json", "JSON output")
  .action(async (opts) => {
    try { await scanYield(getClient(), opts); }
    catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── DCA ──
program.command("dca").description("Execute a DCA buy (or dry-run)")
  .option("--token <symbol>", "token to buy", "ETH")
  .option("--amount <n>", "USDC amount", "5")
  .option("--chain <chain>", "chain to trade on", "base")
  .option("--fear-adjust", "multiply amount by Fear & Greed Index factor")
  .option("--execute", "execute the trade (default: dry-run only)")
  .option("--json", "JSON output")
  .action(async (opts) => {
    try {
      const client = getClient();
      const dryRun = !opts.execute;
      let amount = opts.amount;

      if (opts.fearAdjust) {
        const fear = await getFearIndex();
        const mult = fearMultiplier(fear.value);
        amount = String(Math.round(parseFloat(amount) * mult));
        if (!opts.json) {
          log("dca", `Fear Index: ${fear.value}/100 (${fear.classification}) → ${mult}x multiplier → ${amount} USDC`);
        }
      }

      await executeDCA(client, { ...opts, amount, dryRun });
    } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Arb ──
program.command("arb").description("Scan for cross-chain price opportunities")
  .option("--tokens <list>", "comma-separated tokens", (v) => v.split(","), ["ETH"])
  .option("--chains <list>", "comma-separated chains", (v) => v.split(","), ["base", "arbitrum", "optimism"])
  .option("--min-spread <pct>", "minimum spread %", parseFloat, 0.1)
  .option("--json", "JSON output")
  .action(async (opts) => {
    try { await scanArb(getClient(), opts); }
    catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Predict ──
program.command("predict").description("Scout prediction markets for mispricing")
  .option("--top <n>", "number of markets", parseInt, 10)
  .option("--json", "JSON output")
  .action(async (opts) => {
    try { await scanPredictions(getClient(), opts); }
    catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Grid (take-profit) ──
program.command("grid").description("Check/execute take-profit grid levels")
  .option("--execute", "execute sells when levels are hit (default: check only)")
  .option("--reset", "reset grid levels for a new cycle")
  .option("--json", "JSON output")
  .action(async (opts) => {
    try {
      if (opts.reset) { resetGrid(); return; }
      await checkGrid({ execute: opts.execute, json: opts.json });
    } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Status ──
program.command("status").description("Portfolio dashboard")
  .option("--json", "JSON output")
  .action(async (opts) => {
    try {
      const client = getClient();
      const wallet = process.env.WALLET_ADDRESS;
      const chains = await client.listChains();
      log("status", `Connected — ${chains.length} chains available`);

      // Price check (direct API call to avoid npm SDK ?token= bug)
      const apiKey = requireEnv("SUWAPPU_API_KEY");
      const priceRes = await fetch("https://api.suwappu.bot/v1/agent/prices?symbols=ETH,BTC,SOL", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const priceData = await priceRes.json() as { prices: Record<string, { usd: number; change_24h: number }> };
      console.log();
      for (const [token, data] of Object.entries(priceData.prices)) {
        const change = data.change_24h ?? 0;
        console.log(`  ${token.padEnd(5)} $${data.usd.toLocaleString()} (${change >= 0 ? "+" : ""}${change.toFixed(2)}%)`);
      }

      // Fear index
      const fear = await getFearIndex();
      console.log();
      log("status", `Fear & Greed: ${fear.value}/100 (${fear.classification})`);
      log("status", `DCA multiplier: ${fearMultiplier(fear.value)}x`);

      if (wallet) {
        console.log();
        log("status", `Wallet: ${wallet.slice(0, 6)}...${wallet.slice(-4)}`);
      }
    } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }
  });

// ── Watch (continuous monitoring) ──
program.command("watch").description("Continuously scan for opportunities")
  .option("--interval <secs>", "scan interval in seconds", parseInt, 300)
  .option("--tokens <list>", "arb tokens", (v: string) => v.split(","), ["ETH", "SOL"])
  .option("--chains <list>", "arb chains", (v: string) => v.split(","), ["base", "arbitrum", "optimism", "ethereum"])
  .option("--min-spread <pct>", "min arb spread %", parseFloat, 0.3)
  .option("--json", "JSON output")
  .action(async (opts) => {
    const client = getClient();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let round = 0;

    process.on("SIGINT", () => { log("watch", `Stopped after ${round} rounds.`); process.exit(0); });
    process.on("SIGTERM", () => { log("watch", `Stopped after ${round} rounds.`); process.exit(0); });

    if (!opts.json) {
      log("watch", `Continuous monitoring every ${opts.interval}s. Ctrl+C to stop.`);
      log("watch", `Arb: ${opts.tokens.join(",")} across ${opts.chains.join(",")}`);
      console.log();
    }

    while (true) {
      round++;
      try {
        if (!opts.json) log("watch", `── Round ${round} ──`);

        // Fear index
        const fear = await getFearIndex();
        if (!opts.json) log("watch", `Fear: ${fear.value}/100 (${fear.classification}) | DCA mult: ${fearMultiplier(fear.value)}x`);

        // Arb scan
        const opps = await scanArb(client, {
          tokens: opts.tokens,
          chains: opts.chains,
          minSpread: opts.minSpread,
          json: opts.json,
        });

        const viable = opps.filter((o) => o.viable);
        if (viable.length > 0 && !opts.json) {
          log("watch", `🚨 ${viable.length} PROFITABLE arb opportunity(ies) found!`);
        }

        if (!opts.json) console.log();
      } catch (e: any) {
        if (!opts.json) log("watch", `Error: ${e.message}`);
      }

      await sleep(opts.interval * 1000);
    }
  });

// ── Portfolio ──
program.command("portfolio").description("Risk assessment, Kelly criterion, strategy attribution")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const apiKey = requireEnv("SUWAPPU_API_KEY");
    const walletAddress = process.env.WALLET_ADDRESS || "";
    const state = loadState();
    syncFromDCAHistory(state);

    // Fetch prices + balances
    const priceRes = await fetch("https://api.suwappu.bot/v1/agent/prices?symbols=ETH,BTC,SOL", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const priceData = await priceRes.json() as any;
    const prices: Record<string, number> = {};
    for (const [k, v] of Object.entries(priceData.prices || {})) {
      prices[k] = (v as any).usd ?? 0;
    }
    const ethPrice = prices.ETH ?? 0;

    let usdcBal = 0, ethBal = 0;
    if (walletAddress) {
      [usdcBal, ethBal] = await Promise.all([getUSDCBalance(walletAddress), getETHBalance(walletAddress)]);
      if (usdcBal < 0) usdcBal = 0;
      if (ethBal < 0) ethBal = 0;
    }

    const totalValue = usdcBal + ethBal * ethPrice;
    updatePortfolio(state, usdcBal, ethBal, ethPrice);

    // Backfill rewards
    const getPrice = async (token: string) => {
      const res = await fetch(`https://api.suwappu.bot/v1/agent/prices?symbols=${token}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json() as any;
      return data.prices?.[token]?.usd ?? 0;
    };
    await backfillRewards(state, getPrice);
    adaptParameters(state);
    saveState(state);

    // Generate report
    const report = generatePortfolioReport(state, prices, totalValue);

    // Sizing recommendation (need market data)
    const fear = await getFearIndex();
    let rsi = 50, atrPct = 2.0;
    try {
      const candles = await getCandles("ETHUSDC", "4h", 15);
      rsi = calcRSI(candles);
      atrPct = calcATRPct(candles);
    } catch {}

    const sizing = getRecommendedSize(state, usdcBal, { fearValue: fear.value, rsi, atrPct });

    if (opts.json) {
      console.log(JSON.stringify({ ...report, sizing }, null, 2));
    } else {
      const lines = formatPortfolioReport(report, sizing);
      for (const line of lines) console.log(line);
    }
  });

// ── Run All (V3 — Unified Buy+Sell+Learn) ──
program.command("run").description("Run full flywheel: DCA buy + Grid sell + Brain learn")
  .option("--execute", "execute trades (default: scan only)")
  .option("--amount <n>", "base DCA amount in USDC", "2")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const client = getClient();
    const dryRun = !opts.execute;
    const apiKey = requireEnv("SUWAPPU_API_KEY");
    const walletAddress = process.env.WALLET_ADDRESS || "";

    // 0. Load brain state
    const state = loadState();

    if (!opts.json) {
      console.log("╔══════════════════════════════════════════╗");
      console.log("║  SUWAPPU FLYWHEEL V3 — BUY + SELL + LEARN║");
      console.log("╚══════════════════════════════════════════╝");
      console.log(`  Mode: ${dryRun ? "SCAN ONLY (add --execute)" : "LIVE EXECUTION"}\n`);
    }

    try {
      // 1. Sync brain state with DCA history
      const synced = syncFromDCAHistory(state);
      if (synced > 0 && !opts.json) {
        log("brain", `Synced ${synced} trade(s) from DCA history`);
      }

      // 2. Get on-chain balances
      let usdcBal = -1;
      let ethBal = -1;
      if (walletAddress) {
        [usdcBal, ethBal] = await Promise.all([
          getUSDCBalance(walletAddress),
          getETHBalance(walletAddress),
        ]);
      }

      // 3. Get current ETH price
      const getPrice = async (token: string) => {
        const res = await fetch(`https://api.suwappu.bot/v1/agent/prices?symbols=${token}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const data = await res.json() as { prices?: Record<string, { usd: number }> };
        return data.prices?.[token]?.usd ?? 0;
      };
      const ethPrice = await getPrice("ETH");

      // 4. Update portfolio with real balances
      if (usdcBal >= 0 && ethBal >= 0) {
        updatePortfolio(state, usdcBal, ethBal, ethPrice);
        if (!opts.json) {
          const totalVal = usdcBal + ethBal * ethPrice;
          const pnl = totalVal - state.portfolio.startingCapital;
          const pnlPct = state.portfolio.startingCapital > 0
            ? (pnl / state.portfolio.startingCapital * 100).toFixed(2)
            : "0.00";
          log("portfolio", `USDC: $${usdcBal.toFixed(2)} | ETH: ${ethBal.toFixed(6)} ($${(ethBal * ethPrice).toFixed(2)})`);
          log("portfolio", `Total: $${totalVal.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)`);
          log("portfolio", `Peak: $${state.portfolio.peakValue.toFixed(2)} | Drawdown: ${
            state.portfolio.peakValue > 0
              ? ((state.portfolio.peakValue - totalVal) / state.portfolio.peakValue * 100).toFixed(1)
              : "0.0"
          }%`);
        }
      }

      // 5. Backfill rewards for old trades
      const scored = await backfillRewards(state, getPrice);
      if (scored > 0 && !opts.json) log("brain", `Scored ${scored} previous trade(s)`);

      // 6. Adapt parameters (brain learns)
      const adaptation = adaptParameters(state);
      if (!opts.json && state.trades.length >= 3) {
        log("brain", `Adaptation: ${adaptation.reason}`);
      }

      // 7. Market sentiment + technicals
      const fear = await getFearIndex();
      let rsi = 50;
      let atrPct = 2.0;
      try {
        const candles = await getCandles("ETHUSDC", "4h", 15);
        rsi = calcRSI(candles);
        atrPct = calcATRPct(candles);
      } catch {}
      const rsiMult = rsiMultiplier(rsi);

      if (!opts.json) {
        log("market", `Fear: ${fear.value}/100 (${fear.classification}) | RSI: ${rsi.toFixed(0)} | ATR: ${atrPct.toFixed(1)}%`);
      }

      // ── DCA BUY ──
      if (!opts.json) console.log("\n── DCA BUY ──");
      const baseAmount = parseFloat(opts.amount);
      const sizing = getRecommendedSize(state, usdcBal, { fearValue: fear.value, rsi, atrPct }, baseAmount);
      const effectiveAmount = sizing.amount;

      if (!opts.json) {
        for (const r of sizing.reasoning) log("dca", r);
      }

      if (sizing.paused) {
        if (!opts.json) log("dca", "⚠️  DCA PAUSED by drawdown circuit breaker");
      } else {
        if (!opts.json && rsiMultiplier(rsi) === 0) {
          log("dca", `⚠️  RSI ${rsi.toFixed(0)} > 70 — OVERBOUGHT, skipping buy`);
        }

        // Skip if RSI says overbought
        if (rsiMult === 0 && effectiveAmount === 0) {
          if (!opts.json) log("dca", "Skipped (overbought)");
        }

        const dcaResult = await executeDCA(client, {
          token: "ETH",
          amount: String(effectiveAmount),
          chain: "base",
          dryRun,
          json: opts.json,
        });

        // Record trade in brain state (only for real executions)
        if (dcaResult.executed) {
          recordTrade(state, {
            timestamp: new Date().toISOString(),
            strategy: "dca",
            token: "ETH",
            chain: "base",
            amountIn: effectiveAmount,
            amountOut: parseFloat(dcaResult.toAmount || "0"),
            priceAtEntry: dcaResult.price,
            fearIndex: fear.value,
            txHash: dcaResult.txHash,
          });
        }
      }

      // ── GRID SELL ──
      if (!opts.json) console.log("\n── GRID TAKE-PROFIT ──");
      const gridResult = await checkGrid({
        execute: !dryRun,
        json: opts.json,
        brainState: state,
      });

      // 8. Refresh balances after trades
      if (!dryRun && walletAddress) {
        const [newUsdc, newEth] = await Promise.all([
          getUSDCBalance(walletAddress),
          getETHBalance(walletAddress),
        ]);
        if (newUsdc >= 0 && newEth >= 0) {
          const newPrice = await getPrice("ETH");
          updatePortfolio(state, newUsdc, newEth, newPrice);
        }
      }

      // 9. Save brain state
      saveState(state);

      // ── STATUS ──
      if (!opts.json) {
        console.log("\n── BRAIN STATUS ──");
        log("brain", `Trades: ${state.trades.length} | DCA mult: ${state.adjustments.dcaAmountMultiplier.toFixed(2)}x`);
        log("brain", `Grid profit: $${gridResult.totalProfit.toFixed(2)} | Next sell: ${
          gridResult.avgEntry > 0
            ? `$${(gridResult.avgEntry * 1.05).toFixed(0)} (+5%)`
            : "N/A"
        }`);
        log("brain", `State saved ✓`);
        if (dryRun) log("run", "\nAdd --execute to trade live.");
      }
    } catch (e: any) {
      saveState(state);
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

// ── Scalp ──
program.command("scalp").description("Continuous mean-reversion micro-scalp bot with ML data collection")
  .option("--execute", "execute live trades (default: dry-run)")
  .option("--amount <n>", "trade size in USDC", parseFloat, 2)
  .option("--interval <secs>", "poll interval in seconds", parseInt, 10)
  .action(async (opts) => {
    const { runScalper } = await import("./scalper.js");
    await runScalper({
      execute: !!opts.execute,
      amount: opts.amount,
      interval: opts.interval,
      dryRun: !opts.execute,
    });
  });

program.parseAsync();
