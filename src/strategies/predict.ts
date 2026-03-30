import type { SuwappuClient } from "@suwappu/sdk";
import { log, formatUsd, logJson } from "../utils.js";

interface PredictAlert {
  question: string;
  yesPrice: number;
  noPrice: number;
  mispricing: number; // |yesPrice + noPrice - 1.00|
  volume: string;
  endDate: string;
  category: string;
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
    const sum = yesPrice + noPrice;
    const mispricing = Math.abs(sum - 1.0);
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

  // Sort by mispricing (structural arb potential)
  alerts.sort((a, b) => b.mispricing - a.mispricing);

  if (opts.json) {
    logJson({ strategy: "predict", alerts });
  } else {
    log("predict", `Scanning ${top} prediction markets...`);
    console.log();

    for (const a of alerts) {
      const yPct = (a.yesPrice * 100).toFixed(0);
      const sumPct = ((a.yesPrice + a.noPrice) * 100).toFixed(1);
      const flag = a.mispricing > 0.02 ? " ⚠ MISPRICED" : "";

      console.log(`  ${a.question}`);
      console.log(`    YES: ${yPct}% | Vol: ${a.volume} | Ends: ${a.endDate} | Sum: ${sumPct}%${flag}`);
      console.log();
    }

    const mispriced = alerts.filter((a) => a.mispricing > 0.02);
    if (mispriced.length > 0) {
      log("predict", `${mispriced.length} markets with YES+NO sum ≠ 100% (potential structural arb)`);
    } else {
      log("predict", "No obvious mispricing detected — markets are efficient");
    }
  }

  return alerts;
}
