#!/usr/bin/env bun
import { Command } from "commander";
import { createClient } from "@suwappu/sdk";
import { requireEnv, log } from "./utils.js";
import { scanYield } from "./strategies/yield.js";
import { executeDCA, getFearIndex, fearMultiplier } from "./strategies/dca.js";
import { scanArb } from "./strategies/arb.js";
import { scanPredictions } from "./strategies/predict.js";

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
  .option("--dry-run", "quote only, don't execute", true)
  .option("--json", "JSON output")
  .action(async (opts) => {
    try {
      const client = getClient();
      let amount = opts.amount;

      if (opts.fearAdjust) {
        const fear = await getFearIndex();
        const mult = fearMultiplier(fear.value);
        amount = String(Math.round(parseFloat(amount) * mult));
        if (!opts.json) {
          log("dca", `Fear Index: ${fear.value}/100 (${fear.classification}) → ${mult}x multiplier → ${amount} USDC`);
        }
      }

      await executeDCA(client, { ...opts, amount });
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

// ── Status ──
program.command("status").description("Portfolio dashboard")
  .option("--json", "JSON output")
  .action(async (opts) => {
    try {
      const client = getClient();
      const wallet = process.env.WALLET_ADDRESS;
      const chains = await client.listChains();
      log("status", `Connected — ${chains.length} chains available`);

      // Price check
      const prices = await client.getPrices("ETH,BTC,SOL");
      console.log();
      for (const p of prices) {
        console.log(`  ${p.token.padEnd(5)} $${parseFloat(p.priceUsd).toLocaleString()} (${parseFloat(p.change24h) >= 0 ? "+" : ""}${parseFloat(p.change24h).toFixed(2)}%)`);
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

// ── Run All ──
program.command("run").description("Run all enabled strategies once")
  .option("--dry-run", "don't execute any trades", true)
  .option("--json", "JSON output")
  .action(async (opts) => {
    const client = getClient();
    const dryRun = opts.dryRun;

    if (!opts.json) {
      console.log("╔══════════════════════════════════════════╗");
      console.log("║       SUWAPPU FLYWHEEL — RUN ALL        ║");
      console.log("╚══════════════════════════════════════════╝");
      if (dryRun) console.log("  Mode: DRY RUN (no trades executed)\n");
    }

    try {
      // 1. Status
      const fear = await getFearIndex();
      if (!opts.json) log("run", `Fear & Greed: ${fear.value}/100 (${fear.classification})`);

      // 2. Yield scan
      if (!opts.json) console.log("\n── YIELD ROTATION ──");
      await scanYield(client, { chain: 8453, top: 5, json: opts.json });

      // 3. DCA
      if (!opts.json) console.log("\n── DCA ──");
      const mult = fearMultiplier(fear.value);
      const dcaAmount = String(Math.round(5 * mult));
      if (!opts.json) log("dca", `Fear multiplier: ${mult}x → buying ${dcaAmount} USDC of ETH`);
      await executeDCA(client, { token: "ETH", amount: dcaAmount, chain: "base", dryRun, json: opts.json });

      // 4. Arb scan
      if (!opts.json) console.log("\n── ARB SCANNER ──");
      await scanArb(client, { tokens: ["ETH"], chains: ["base", "arbitrum", "optimism"], minSpread: 0.1, json: opts.json });

      // 5. Prediction scout
      if (!opts.json) console.log("\n── PREDICTION SCOUT ──");
      await scanPredictions(client, { top: 5, json: opts.json });

      if (!opts.json) {
        console.log("\n── SUMMARY ──");
        log("run", "All strategies scanned. Review above for opportunities.");
        if (dryRun) log("run", "Remove --dry-run to enable DCA execution.");
      }
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
  });

program.parseAsync();
