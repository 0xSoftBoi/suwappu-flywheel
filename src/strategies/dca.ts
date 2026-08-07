import type { SuwappuClient } from "@suwappu/sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log, formatUsd, logJson } from "../utils.js";
import { markExecutionAccounted, runManagedExecution } from "../execution.js";

function historyDir(): string {
  return process.env.SUWAPPU_FLYWHEEL_STATE_DIR ?? join(homedir(), ".suwappu-flywheel");
}

function historyFile(): string {
  return join(historyDir(), "dca-history.json");
}

export interface HistoryEntry {
  timestamp: string;
  token: string;
  amount: string;
  price: number;
  toAmount: string;
  chain: string;
  fearIndex?: number;
  multiplier?: number;
  executionStatus?: "completed" | "confirmed";
  intentId?: string;
  quoteId?: string;
  swapId?: string;
  txHash?: string;
}

function loadHistory(): HistoryEntry[] {
  try {
    if (existsSync(historyFile())) return JSON.parse(readFileSync(historyFile(), "utf-8"));
  } catch {}
  return [];
}

function saveHistory(entries: HistoryEntry[]) {
  const dir = historyDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(historyFile(), JSON.stringify(entries, null, 2));
}

export function getDCAHistory(): HistoryEntry[] {
  return loadHistory();
}

/** Legacy history was written at submission time, so only new verified rows are accounting-safe. */
export function isConfirmedDCAHistory(entry: HistoryEntry): boolean {
  return entry.executionStatus === "completed" || entry.executionStatus === "confirmed";
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
  submitted?: boolean;
  dryRun: boolean;
  skipped?: boolean;
  skipReason?: string;
  swapId?: string;
  swapStatus?: string;
  txHash?: string;
  intentId?: string;
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

  if (!Number.isFinite(parseFloat(amount)) || parseFloat(amount) <= 0) {
    const reason = `DCA amount must be greater than 0 (received ${amount})`;
    if (!opts.json) log("dca", `Skipped: ${reason}`);
    return {
      token, price: 0, amount, chain,
      executed: false, dryRun,
      skipped: true, skipReason: reason,
    };
  }

  const maxTradeUsd = parseFloat(process.env.SUWAPPU_MAX_TRADE_USD ?? "1000");
  if (!dryRun && Number.isFinite(maxTradeUsd) && parseFloat(amount) > maxTradeUsd) {
    const reason = `DCA amount ${amount} exceeds live cap ${maxTradeUsd}; change SUWAPPU_MAX_TRADE_USD deliberately to raise it`;
    if (!opts.json) log("dca", `Skipped: ${reason}`);
    return {
      token, price: 0, amount, chain,
      executed: false, dryRun,
      skipped: true, skipReason: reason,
    };
  }

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

  const result: DCAResult = {
    token, price, amount, chain,
    executed: false,
    dryRun,
  };

  if (dryRun) {
    const quote = await client.getQuote("USDC", token, parseFloat(amount), chain);
    result.quoteId = quote.id;
    result.toAmount = quote.toAmount;
    if (opts.json) {
      logJson({ strategy: "dca", action: "dry_run", ...result });
    } else {
      log("dca", `DRY RUN: Would buy ${amount} USDC → ${quote.toAmount} ${token} on ${chain}`);
      log("dca", `  Rate: 1 ${token} = ${formatUsd(price)} | Via: ${quote.dex || "auto"}`);
    }
  } else {
    const receipt = await runManagedExecution({
      apiKey,
      strategy: "dca",
      actionKey: "buy",
      terms: { fromToken: "USDC", toToken: token, amount, chain },
      getQuote: async () => {
        const quote = await client.getQuote("USDC", token, parseFloat(amount), chain);
        return { id: quote.id, toAmount: quote.toAmount };
      },
      walletAddress: process.env.SUWAPPU_MANAGED_WALLET_ADDRESS,
      context: { price, decisionAt: new Date().toISOString() },
    });
    const intent = receipt.intent;
    const recordedPrice = typeof intent.context?.price === "number" ? intent.context.price : price;

    result.price = recordedPrice;
    result.intentId = intent.id;
    result.quoteId = intent.quoteId;
    result.toAmount = intent.actualToAmount ?? intent.quotedToAmount;
    result.swapId = intent.swapId;
    result.swapStatus = intent.swapStatus ?? intent.phase;
    result.txHash = intent.txHash;
    result.submitted = ["submitting", "submitted", "outcome_unknown"].includes(intent.phase);

    // Accounting and learning only consume a reconciled terminal success with a
    // final amount from the status record. A quote amount is never a fill.
    if (intent.phase === "completed" && intent.actualToAmount) {
      result.executed = true;
      result.toAmount = intent.actualToAmount;
      const history = loadHistory();
      if (!history.some((entry) => entry.intentId === intent.id)) {
        history.push({
          timestamp: typeof intent.context?.decisionAt === "string" ? intent.context.decisionAt : intent.createdAt,
          token,
          amount: intent.actualFromAmount ?? amount,
          price: recordedPrice,
          toAmount: intent.actualToAmount,
          chain,
          executionStatus: "completed",
          intentId: intent.id,
          quoteId: intent.quoteId,
          swapId: intent.swapId,
          txHash: intent.txHash,
        });
        saveHistory(history);
      }
      markExecutionAccounted(intent.id);
    }

    const action = result.executed
      ? "confirmed"
      : intent.phase === "failed"
        ? "failed"
        : intent.phase;
    if (opts.json) {
      logJson({
        strategy: "dca",
        action,
        intentId: intent.id,
        simulation: receipt.simulation,
        error: intent.error,
        ...result,
      });
    } else if (result.executed) {
      log("dca", `CONFIRMED: ${result.amount} USDC → ${intent.actualToAmount} ${token} | Swap ${intent.swapId}`);
      if (intent.txHash) log("dca", `  TX: ${intent.txHash}`);
    } else if (intent.phase === "failed") {
      log("dca", `NOT EXECUTED: ${intent.error ?? intent.swapStatus ?? "failed"}`);
    } else if (intent.phase === "outcome_unknown") {
      log("dca", `OUTCOME UNKNOWN: intent ${intent.id}. The same idempotency key will be reused; do not create a replacement trade.`);
      if (intent.error) log("dca", `  ${intent.error}`);
    } else {
      log("dca", `SUBMITTED: intent ${intent.id}${intent.swapId ? ` | Swap ${intent.swapId}` : ""} (${intent.swapStatus ?? intent.phase})`);
      log("dca", "  Not counted as a fill yet; rerun to reconcile status.");
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
