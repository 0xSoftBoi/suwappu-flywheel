import type { SuwappuClient } from "@suwappu/sdk";
import { log, formatUsd, logJson } from "../utils.js";

interface PredictAlert {
  question: string;
  yesPrice: number;
  noPrice: number;
  mispricing: number; // legacy field name: absolute YES+NO price-sum deviation, not guaranteed edge
  volume: string;
  endDate: string;
  category: string;
}

export function predictionPriceSumDeviation(yesPrice: number, noPrice: number): number {
  return Math.abs(yesPrice + noPrice - 1.0);
}

export async function scanPredictions(
  client: SuwappuClient,
  opts: { top?: number; minVolume?: number; json?: boolean }
): Promise<PredictAlert[]> {
  const top = opts.top ?? 10;
  const markets = await client.predict.markets(undefined, top);
  const alerts: PredictAlert[] = [];

  for (const m of markets) {
    const [yesPrice, noPrice] = m.outcomePrices;
    const mispricing = predictionPriceSumDeviation(yesPrice, noPrice);
    const volume = m.volume > 1e6
      ? `${(m.volume / 1e6).toFixed(1)}M`
      : `${(m.volume / 1e3).toFixed(0)}K`;

    alerts.push({
      question: m.question,
      yesPrice,
      noPrice,
      mispricing,
      volume: `$${volume}`,
      endDate: m.endDate.slice(0, 10),
      category: m.category,
    });
  }

  // Sort by price-sum deviation. Spread, fees, stale books, and execution can
  // all create a deviation without creating a realizable arbitrage.
  alerts.sort((a, b) => b.mispricing - a.mispricing);

  if (opts.json) {
    logJson({ strategy: "predict", alerts });
  } else {
    log("predict", `Scanning ${top} prediction markets...`);
    console.log();

    for (const a of alerts) {
      const yPct = (a.yesPrice * 100).toFixed(0);
      const sumPct = ((a.yesPrice + a.noPrice) * 100).toFixed(1);
      const flag = a.mispricing > 0.02 ? " ⚠ PRICE-SUM DEVIATION" : "";

      console.log(`  ${a.question}`);
      console.log(`    YES: ${yPct}% | Vol: ${a.volume} | Ends: ${a.endDate} | Sum: ${sumPct}%${flag}`);
      console.log();
    }

    const deviating = alerts.filter((a) => a.mispricing > 0.02);
    if (deviating.length > 0) {
      log("predict", `${deviating.length} markets with YES+NO sum more than 2% from 100%; treat this as a screening signal, not executable edge`);
    } else {
      log("predict", "No YES+NO price-sum deviations above 2% in this sample");
    }
  }

  return alerts;
}
