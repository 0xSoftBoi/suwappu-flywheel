import type { SuwappuClient } from "@suwappu/sdk";
import { log, formatUsd, logJson } from "../utils.js";

interface DCAResult {
  token: string;
  price: number;
  amount: string;
  chain: string;
  quoteId?: string;
  toAmount?: string;
  executed: boolean;
  dryRun: boolean;
}

export async function executeDCA(
  client: SuwappuClient,
  opts: {
    token?: string;
    amount?: string;
    chain?: string;
    dryRun?: boolean;
    json?: boolean;
  }
): Promise<DCAResult> {
  const token = opts.token ?? "ETH";
  const amount = opts.amount ?? "5";
  const chain = opts.chain ?? "base";
  const dryRun = opts.dryRun ?? true;

  // Get current price (direct API call to avoid SDK bug with ?token= vs ?symbols=)
  const apiKey = process.env.SUWAPPU_API_KEY ?? "";
  const priceRes = await fetch(`https://api.suwappu.bot/v1/agent/prices?symbols=${token}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const priceData = await priceRes.json() as { prices?: Record<string, { usd: number }> };
  const price = priceData.prices?.[token]?.usd ?? 0;

  if (!opts.json) {
    log("dca", `${token}: ${formatUsd(price)}`);
  }

  // Get quote
  const quote = await client.getQuote("USDC", token, parseFloat(amount), chain);

  const result: DCAResult = {
    token,
    price,
    amount,
    chain,
    quoteId: quote.id,
    toAmount: quote.toAmount,
    executed: false,
    dryRun,
  };

  if (dryRun) {
    if (opts.json) {
      logJson({ strategy: "dca", action: "dry_run", ...result });
    } else {
      log("dca", `DRY RUN: Would buy ${amount} USDC → ${quote.toAmount} ${token} on ${chain}`);
      log("dca", `  Rate: 1 ${token} = ${formatUsd(price)} | Via: ${quote.dex || "auto"}`);
    }
  } else {
    // Execute the swap
    try {
      const swap = await client.executeSwap(quote.id);
      result.executed = true;
      if (opts.json) {
        logJson({ strategy: "dca", action: "executed", txHash: swap.txHash, ...result });
      } else {
        log("dca", `EXECUTED: ${amount} USDC → ${quote.toAmount} ${token}`);
        log("dca", `  TX: ${swap.txHash || "pending"} | Status: ${swap.status}`);
      }
    } catch (e: any) {
      if (opts.json) {
        logJson({ strategy: "dca", action: "failed", error: e.message, ...result });
      } else {
        log("dca", `FAILED: ${e.message}`);
      }
    }
  }

  return result;
}

/** Fetch Fear & Greed Index (free API) */
export async function getFearIndex(): Promise<{ value: number; classification: string }> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    const data = await res.json() as { data: Array<{ value: string; value_classification: string }> };
    return {
      value: parseInt(data.data[0].value),
      classification: data.data[0].value_classification,
    };
  } catch {
    return { value: 50, classification: "Neutral" };
  }
}

/** Calculate DCA multiplier based on Fear & Greed Index */
export function fearMultiplier(fearValue: number): number {
  if (fearValue <= 10) return 4.0; // Extreme Fear → buy 4x
  if (fearValue <= 25) return 2.0; // Fear → buy 2x
  if (fearValue <= 50) return 1.0; // Neutral → normal
  if (fearValue <= 75) return 0.5; // Greed → buy 0.5x
  return 0.25;                      // Extreme Greed → buy 0.25x
}
