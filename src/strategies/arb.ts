import type { SuwappuClient } from "@suwappu/sdk";
import { log, formatUsd, formatPct, logJson } from "../utils.js";
import { executeManagedSwap } from "../suwappu.js";

export interface ArbOpportunity {
  token: string;
  buyChain: string;
  sellChain: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  estProfitPer1K: number; // estimated profit on $1000 trade
  viable: boolean; // profitable after estimated gas+bridge fees
}

export interface ArbExecuteResult {
  executed: boolean;
  dryRun: boolean;
  token: string;
  buyChain: string;
  amount: number;
  toAmount?: string;
  swapId?: string;
  swapStatus?: string;
  txHash?: string;
  error?: string;
}

// Estimated bridge + gas costs per chain pair (conservative)
const BRIDGE_COST_USD: Record<string, number> = {
  "base→ethereum": 3.0,
  "arbitrum→ethereum": 3.0,
  "optimism→ethereum": 3.0,
  "base→arbitrum": 0.50,
  "base→optimism": 0.50,
  "arbitrum→base": 0.50,
  "arbitrum→optimism": 0.50,
  "optimism→base": 0.50,
  "optimism→arbitrum": 0.50,
  "ethereum→base": 5.0,
  "ethereum→arbitrum": 5.0,
  "ethereum→optimism": 5.0,
};

function getBridgeCost(from: string, to: string): number {
  return BRIDGE_COST_USD[`${from}→${to}`] ?? 2.0;
}

export async function scanArb(
  client: SuwappuClient,
  opts: {
    tokens?: string[];
    chains?: string[];
    minSpread?: number;
    json?: boolean;
  }
): Promise<ArbOpportunity[]> {
  const tokens = opts.tokens ?? ["ETH"];
  const chains = opts.chains ?? ["base", "arbitrum", "optimism"];
  const minSpread = opts.minSpread ?? 0.1;
  const opportunities: ArbOpportunity[] = [];

  if (!opts.json) {
    log("arb", `Scanning ${tokens.join(",")} across ${chains.join(",")}...`);
    console.log();
  }

  for (const token of tokens) {
    // Get price on each chain by quoting 1 USDC → token
    const chainPrices: Array<{ chain: string; price: number }> = [];

    for (const chain of chains) {
      try {
        const quote = await client.getQuote("USDC", token, 100, chain);
        const price = 100 / parseFloat(quote.toAmount);
        chainPrices.push({ chain, price });
      } catch {
        // Chain might not support this token
      }
    }

    if (chainPrices.length < 2) continue;

    // Find spreads
    if (!opts.json) {
      console.log(`  ${token} prices:`);
      for (const cp of chainPrices) {
        console.log(`    ${cp.chain.padEnd(12)} ${formatUsd(cp.price)}`);
      }
    }

    // Compare all pairs
    for (let i = 0; i < chainPrices.length; i++) {
      for (let j = 0; j < chainPrices.length; j++) {
        if (i === j) continue;
        const spread = ((chainPrices[j].price - chainPrices[i].price) / chainPrices[i].price) * 100;
        if (spread >= minSpread) {
          const tradeSize = 1000;
          const grossProfit = tradeSize * (spread / 100);
          const bridgeCost = getBridgeCost(chainPrices[i].chain, chainPrices[j].chain);
          const slippage = tradeSize * 0.003; // ~0.3% slippage estimate
          const netProfit = grossProfit - bridgeCost - slippage;

          const opp: ArbOpportunity = {
            token,
            buyChain: chainPrices[i].chain,
            sellChain: chainPrices[j].chain,
            buyPrice: chainPrices[i].price,
            sellPrice: chainPrices[j].price,
            spreadPct: spread,
            estProfitPer1K: netProfit,
            viable: netProfit > 0,
          };
          opportunities.push(opp);
        }
      }
    }
  }

  if (opts.json) {
    logJson({ strategy: "arb", opportunities });
  } else {
    console.log();
    if (opportunities.length === 0) {
      log("arb", `No spreads above ${minSpread}% found`);
    } else {
      const viable = opportunities.filter((o) => o.viable);
      const notViable = opportunities.filter((o) => !o.viable);

      log("arb", `Found ${opportunities.length} spreads (${viable.length} profitable after fees):`);
      for (const o of opportunities.sort((a, b) => b.estProfitPer1K - a.estProfitPer1K)) {
        const profitStr = o.viable
          ? `✅ Net: ${formatUsd(o.estProfitPer1K)}/1K`
          : `❌ Net: ${formatUsd(o.estProfitPer1K)}/1K (fees eat profit)`;
        console.log(`    ${o.token}: ${o.buyChain} → ${o.sellChain} | Spread: ${formatPct(o.spreadPct)} | ${profitStr}`);
      }
      console.log();
      if (viable.length > 0) {
        const best = viable[0];
        log("arb", `💰 Best: ${best.token} ${best.buyChain}→${best.sellChain} nets ${formatUsd(best.estProfitPer1K)} per $1K traded`);
      }
      log("arb", "Note: Bridge time 1-15min. Prices may move. Slippage estimated at 0.3%.");
    }
  }

  return opportunities;
}

/** Execute the buy leg of an arb opportunity (buy cheap on buyChain) */
export async function executeArb(
  client: SuwappuClient,
  opp: ArbOpportunity,
  opts: { amount?: number; dryRun?: boolean; json?: boolean }
): Promise<ArbExecuteResult> {
  const amount = opts.amount ?? 100; // USDC to spend on buy leg
  const dryRun = opts.dryRun ?? true;
  const apiKey = process.env.SUWAPPU_API_KEY ?? "";

  const result: ArbExecuteResult = {
    executed: false,
    dryRun,
    token: opp.token,
    buyChain: opp.buyChain,
    amount,
  };

  try {
    // Get quote on the cheap chain
    const quote = await client.getQuote("USDC", opp.token, amount, opp.buyChain);
    result.toAmount = quote.toAmount;

    if (!opts.json) {
      log("arb", `Quote: $${amount} USDC → ${quote.toAmount} ${opp.token} on ${opp.buyChain}`);
    }

    if (dryRun) {
      if (opts.json) {
        logJson({ strategy: "arb", action: "dry_run", ...result });
      } else {
        log("arb", `DRY RUN: Would buy ${quote.toAmount} ${opp.token} on ${opp.buyChain}`);
        log("arb", `  Then bridge to ${opp.sellChain} and sell for ~${fmtProfitEst(amount, opp.spreadPct)}`);
      }
    } else {
      const swap = await executeManagedSwap(apiKey, quote.id);
      result.executed = true;
      result.swapId = swap.swapId;
      result.swapStatus = swap.status;
      result.txHash = swap.txHash;

      if (opts.json) {
        logJson({
          strategy: "arb",
          action: "submitted_buy_leg",
          swapId: swap.swapId,
          status: swap.status,
          txHash: swap.txHash,
          pollUrl: swap.pollUrl,
          ...result,
        });
      } else {
        log("arb", `SUBMITTED buy leg: $${amount} → ${quote.toAmount} ${opp.token} on ${opp.buyChain} | Swap ${swap.swapId} (${swap.status})`);
        if (swap.txHash) log("arb", `  TX: ${swap.txHash}`);
        if (swap.pollUrl) log("arb", `  Status: ${swap.pollUrl}`);
        log("arb", `  ⚠ Bridge to ${opp.sellChain} and sell manually to complete arb`);
      }
    }
  } catch (e: any) {
    result.error = e.message;
    if (opts.json) {
      logJson({ strategy: "arb", action: "failed", error: e.message, ...result });
    } else {
      log("arb", `FAILED: ${e.message}`);
    }
  }

  return result;
}

function fmtProfitEst(amount: number, spreadPct: number): string {
  const profit = amount * (spreadPct / 100);
  return formatUsd(amount + profit);
}
