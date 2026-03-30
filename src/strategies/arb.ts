import type { SuwappuClient } from "@suwappu/sdk";
import { log, formatUsd, formatPct, logJson } from "../utils.js";

interface ArbOpportunity {
  token: string;
  buyChain: string;
  sellChain: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  estProfitPer1K: number; // estimated profit on $1000 trade
  viable: boolean; // profitable after estimated gas+bridge fees
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
