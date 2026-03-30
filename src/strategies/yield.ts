import type { SuwappuClient } from "@suwappu/sdk";
import { log, formatUsd, formatPct, logJson } from "../utils.js";

interface YieldOpportunity {
  id: string;
  pair: string;
  supplyApy: number;
  borrowApy: number;
  utilization: number;
  totalSupply: number;
  loanToken: string;
  collateralToken: string;
}

export async function scanYield(
  client: SuwappuClient,
  opts: { chain?: number; top?: number; minApy?: number; json?: boolean }
): Promise<YieldOpportunity[]> {
  const chainId = opts.chain ?? 8453; // Base
  const markets = await client.lend.markets(chainId);

  const sorted = [...markets]
    .filter((m) => m.supplyApy >= (opts.minApy ?? 0))
    .sort((a, b) => b.supplyApy - a.supplyApy)
    .slice(0, opts.top ?? 10);

  const opportunities: YieldOpportunity[] = sorted.map((m) => ({
    id: m.id,
    pair: `${m.loanToken}/${m.collateralToken}`,
    supplyApy: m.supplyApy,
    borrowApy: m.borrowApy,
    utilization: m.utilization,
    totalSupply: m.totalSupply,
    loanToken: m.loanToken,
    collateralToken: m.collateralToken,
  }));

  if (opts.json) {
    logJson({ strategy: "yield", chain: chainId, markets: opportunities });
  } else {
    log("yield", `Scanning Morpho markets on chain ${chainId}...`);
    console.log();
    console.log("  Market                     Supply APY   Utilization   TVL");
    console.log("  " + "─".repeat(62));
    for (const m of opportunities) {
      const tvl = m.totalSupply > 1e6
        ? `${formatUsd(m.totalSupply / 1e6)}M`
        : `${formatUsd(m.totalSupply / 1e3)}K`;
      console.log(
        `  ${m.pair.padEnd(25)} ${m.supplyApy.toFixed(2)}%`.padEnd(42) +
        `${m.utilization.toFixed(1)}%`.padEnd(14) + tvl
      );
    }

    if (opportunities.length > 0) {
      const best = opportunities[0];
      console.log();
      log("yield", `Best: ${best.pair} at ${best.supplyApy.toFixed(2)}% APY`);
      log("yield", `$100 deposited here earns ~${formatUsd((100 * best.supplyApy) / 100)}/year`);
    }
  }

  return opportunities;
}
