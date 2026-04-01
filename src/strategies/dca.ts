import type { SuwappuClient } from "@suwappu/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log, formatUsd, logJson } from "../utils.js";

const HISTORY_DIR = join(homedir(), ".suwappu-flywheel");
const HISTORY_FILE = join(HISTORY_DIR, "dca-history.json");

interface HistoryEntry {
  timestamp: string;
  token: string;
  amount: string;
  price: number;
  toAmount: string;
  chain: string;
  fearIndex?: number;
  multiplier?: number;
}

function loadHistory(): HistoryEntry[] {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveHistory(entries: HistoryEntry[]) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

export function getDCAHistory(): HistoryEntry[] {
  return loadHistory();
}

/** Check USDC balance on-chain via Base RPC */
export async function getUSDCBalance(walletAddress: string): Promise<number> {
  const USDC = "833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const addr = walletAddress.replace("0x", "");
  const data = `0x70a08231000000000000000000000000${addr}`;
  try {
    const res = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_call",
        params: [{ to: `0x${USDC}`, data }, "latest"],
      }),
    });
    const json = await res.json() as { result: string };
    return parseInt(json.result, 16) / 1e6; // USDC has 6 decimals
  } catch {
    return -1; // error — don't block on RPC failure
  }
}

/** Check ETH balance on-chain */
export async function getETHBalance(walletAddress: string): Promise<number> {
  try {
    const res = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_getBalance",
        params: [walletAddress, "latest"],
      }),
    });
    const json = await res.json() as { result: string };
    return parseInt(json.result, 16) / 1e18;
  } catch {
    return -1;
  }
}

interface DCAResult {
  token: string;
  price: number;
  amount: string;
  chain: string;
  quoteId?: string;
  toAmount?: string;
  executed: boolean;
  dryRun: boolean;
  skipped?: boolean;
  skipReason?: string;
  txHash?: string;
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
  const apiKey = process.env.SUWAPPU_API_KEY ?? "";
  const walletAddress = process.env.WALLET_ADDRESS ?? "";

  // Check USDC balance before trading
  if (!dryRun && walletAddress) {
    const usdcBal = await getUSDCBalance(walletAddress);
    if (usdcBal >= 0 && usdcBal < parseFloat(amount)) {
      const reason = usdcBal < 10
        ? `USDC balance too low ($${usdcBal.toFixed(2)}) — DCA paused`
        : `Insufficient USDC ($${usdcBal.toFixed(2)}) for $${amount} trade`;
      if (!opts.json) log("dca", `⚠️  ${reason}`);
      return {
        token, price: 0, amount, chain,
        executed: false, dryRun: false,
        skipped: true, skipReason: reason,
      };
    }
  }

  // Get current price
  const priceRes = await fetch(`https://api.suwappu.bot/v1/agent/prices?symbols=${token}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const priceData = await priceRes.json() as { prices?: Record<string, { usd: number }> };
  const price = priceData.prices?.[token]?.usd ?? 0;

  if (!opts.json) log("dca", `${token}: ${formatUsd(price)}`);

  // Get quote
  const quote = await client.getQuote("USDC", token, parseFloat(amount), chain);

  const result: DCAResult = {
    token, price, amount, chain,
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
    // Execute the swap via sign-and-send
    try {
      const swapRes = await fetch("https://api.suwappu.bot/v1/agent/swap/sign-and-send", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ quote_id: quote.id }),
      });
      const swap = await swapRes.json() as { tx_hash?: string; success?: boolean; error?: string; explorer_url?: string };
      if (!swap.success) throw new Error(swap.error || "Swap failed");
      result.executed = true;
      result.txHash = swap.tx_hash;

      // Save to DCA history
      const history = loadHistory();
      history.push({
        timestamp: new Date().toISOString(),
        token, amount, price,
        toAmount: quote.toAmount,
        chain,
      });
      saveHistory(history);

      if (opts.json) {
        logJson({ strategy: "dca", action: "executed", txHash: swap.tx_hash, explorer: swap.explorer_url, ...result });
      } else {
        log("dca", `EXECUTED: ${amount} USDC → ${quote.toAmount} ${token}`);
        log("dca", `  TX: ${swap.tx_hash}`);
        log("dca", `  Explorer: ${swap.explorer_url}`);
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
  if (fearValue <= 10) return 4.0;
  if (fearValue <= 25) return 2.0;
  if (fearValue <= 50) return 1.0;
  if (fearValue <= 75) return 0.5;
  return 0.25;
}
