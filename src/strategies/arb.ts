import type { SuwappuClient } from "@suwappu/sdk";
import { log, formatUsd, formatPct, logJson } from "../utils.js";

interface ArbOpportunity {
  token: string;
  buyChain: string;
  sellChain: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
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
          const opp: ArbOpportunity = {
            token,
            buyChain: chainPrices[i].chain,
            sellChain: chainPrices[j].chain,
            buyPrice: chainPrices[i].price,
            sellPrice: chainPrices[j].price,
            spreadPct: spread,
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
      log("arb", `Found ${opportunities.length} opportunities:`);
      for (const o of opportunities.sort((a, b) => b.spreadPct - a.spreadPct)) {
        console.log(`    ${o.token}: Buy on ${o.buyChain} (${formatUsd(o.buyPrice)}) → Sell on ${o.sellChain} (${formatUsd(o.sellPrice)}) | Spread: ${formatPct(o.spreadPct)}`);
      }
      console.log();
      log("arb", "Note: Cross-chain arb requires bridge time (1-15min). Prices may move.");
    }
  }

  return opportunities;
}
