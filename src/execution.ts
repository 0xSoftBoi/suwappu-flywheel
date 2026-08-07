/**
 * Durable managed-execution coordinator.
 *
 * A strategy decision is not a fill. This journal persists one idempotency key
 * before submission, simulates every fresh quote, and reconciles a known
 * swap_id before callers are allowed to account for an outcome.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  executeManagedSwap,
  getManagedSwapStatus,
  isFailedSwapStatus,
  isSuccessfulSwapStatus,
  ManagedSwapRequestError,
  simulateManagedSwap,
} from "./suwappu.js";

export type ExecutionPhase =
  | "prepared"
  | "submitting"
  | "submitted"
  | "completed"
  | "failed"
  | "outcome_unknown";

export interface EconomicTerms {
  fromToken: string;
  toToken: string;
  amount: string;
  chain: string;
}

export interface ExecutionIntent {
  id: string;
  strategy: string;
  actionKey: string;
  phase: ExecutionPhase;
  terms: EconomicTerms;
  context?: Record<string, string | number | boolean | null>;
  quoteId?: string;
  quotedToAmount?: string;
  swapId?: string;
  swapStatus?: string;
  txHash?: string;
  actualFromAmount?: string;
  actualToAmount?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  accountedAt?: string;
}

export interface ExecutionReceipt {
  intent: ExecutionIntent;
  simulation?: {
    wouldExecute: boolean;
    warnings: string[];
    checks: Array<{ name: string; status: string; detail: string }>;
  };
}

export interface QuoteForExecution {
  id: string;
  toAmount: string;
}

function stateDir(): string {
  return process.env.SUWAPPU_FLYWHEEL_STATE_DIR ?? join(homedir(), ".suwappu-flywheel");
}

function journalFile(): string {
  return join(stateDir(), "execution-journal.json");
}

function loadJournal(): ExecutionIntent[] {
  try {
    if (existsSync(journalFile())) {
      const parsed = JSON.parse(readFileSync(journalFile(), "utf-8"));
      if (Array.isArray(parsed)) return parsed as ExecutionIntent[];
    }
  } catch {}
  return [];
}

function saveJournal(entries: ExecutionIntent[]): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = journalFile();
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries, null, 2));
  renameSync(temporary, target);
}

function saveEntry(entry: ExecutionIntent): void {
  const entries = loadJournal();
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  entry.updatedAt = new Date().toISOString();
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  saveJournal(entries.slice(-500));
}

function sameTerms(a: EconomicTerms, b: EconomicTerms): boolean {
  return (
    a.fromToken.toUpperCase() === b.fromToken.toUpperCase()
    && a.toToken.toUpperCase() === b.toToken.toUpperCase()
    && a.chain.toLowerCase() === b.chain.toLowerCase()
    && a.amount === b.amount
  );
}

function makeIntentId(strategy: string): string {
  const safeStrategy = strategy.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 16) || "trade";
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `fw.${safeStrategy}.${Date.now().toString(36)}.${random}`.slice(0, 64);
}

function currentIntent(strategy: string, actionKey: string): ExecutionIntent | undefined {
  return loadJournal()
    .slice()
    .reverse()
    .find((entry) => (
      entry.strategy === strategy
      && entry.actionKey === actionKey
      && !entry.accountedAt
      && entry.phase !== "failed"
    ));
}

export function getUnaccountedExecution(
  strategy: string,
  actionKey?: string,
): ExecutionIntent | undefined {
  return loadJournal()
    .slice()
    .reverse()
    .find((entry) => (
      entry.strategy === strategy
      && (actionKey === undefined || entry.actionKey === actionKey)
      && !entry.accountedAt
      && entry.phase !== "failed"
    ));
}

export function listExecutionJournal(limit = 25): ExecutionIntent[] {
  return loadJournal().slice(-Math.max(1, limit)).reverse();
}

/** Poll known swap_ids without creating quotes or submitting transactions. */
export async function reconcileExecutionJournal(apiKey: string): Promise<ExecutionIntent[]> {
  const entries = loadJournal();
  for (const entry of entries) {
    if (entry.accountedAt || !entry.swapId || entry.phase === "failed") continue;
    await reconcileKnownSwap(apiKey, entry);
  }
  return listExecutionJournal(entries.length || 1);
}

export function markExecutionAccounted(intentId: string): void {
  const entries = loadJournal();
  const entry = entries.find((candidate) => candidate.id === intentId);
  if (!entry) return;
  entry.accountedAt = new Date().toISOString();
  entry.updatedAt = entry.accountedAt;
  saveJournal(entries);
}

function applyStatus(entry: ExecutionIntent, status: Awaited<ReturnType<typeof getManagedSwapStatus>>): void {
  entry.swapId = status.swapId;
  entry.swapStatus = status.status;
  entry.txHash = status.txHash ?? entry.txHash;
  entry.actualFromAmount = status.fromAmount ?? entry.actualFromAmount;
  entry.actualToAmount = status.toAmount ?? entry.actualToAmount;
  entry.error = status.errorMessage ?? undefined;
  if (isSuccessfulSwapStatus(status.status)) entry.phase = "completed";
  else if (isFailedSwapStatus(status.status)) entry.phase = "failed";
  else entry.phase = "submitted";
}

async function reconcileKnownSwap(apiKey: string, entry: ExecutionIntent): Promise<ExecutionIntent> {
  if (!entry.swapId) return entry;
  try {
    const status = await getManagedSwapStatus(apiKey, entry.swapId);
    applyStatus(entry, status);
    saveEntry(entry);
  } catch (error) {
    entry.error = `Reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    saveEntry(entry);
  }
  return entry;
}

/**
 * Run or resume one economic intent.
 *
 * The same strategy/action key remains bound to its persisted idempotency key
 * until the caller marks the terminal outcome as accounted. If a previous
 * request has a known swap_id, this function only reconciles it; it never
 * submits another economic action.
 */
export async function runManagedExecution(args: {
  apiKey: string;
  strategy: string;
  actionKey: string;
  terms: EconomicTerms;
  getQuote: () => Promise<QuoteForExecution>;
  walletAddress?: string;
  context?: Record<string, string | number | boolean | null>;
}): Promise<ExecutionReceipt> {
  let intent = currentIntent(args.strategy, args.actionKey);

  if (intent && !sameTerms(intent.terms, args.terms)) {
    throw new Error(
      `Unreconciled ${args.strategy}/${args.actionKey} intent ${intent.id} has different economic terms; reconcile it before creating a new action`,
    );
  }

  if (intent?.phase === "completed") {
    if (intent.swapId && (!intent.actualFromAmount || !intent.actualToAmount)) {
      intent = await reconcileKnownSwap(args.apiKey, intent);
    }
    return { intent };
  }

  if (intent?.swapId) {
    intent = await reconcileKnownSwap(args.apiKey, intent);
    return { intent };
  }

  const isNew = !intent;
  if (!intent) {
    const now = new Date().toISOString();
    intent = {
      id: makeIntentId(args.strategy),
      strategy: args.strategy,
      actionKey: args.actionKey,
      phase: "prepared",
      terms: args.terms,
      context: args.context,
      createdAt: now,
      updatedAt: now,
    };
    saveEntry(intent);
  }

  let quote: QuoteForExecution;
  try {
    quote = await args.getQuote();
  } catch (error) {
    if (isNew) {
      intent.phase = "failed";
      intent.error = `Quote failed before submission: ${error instanceof Error ? error.message : String(error)}`;
      saveEntry(intent);
    }
    throw error;
  }

  intent.quoteId = quote.id;
  intent.quotedToAmount = quote.toAmount;
  saveEntry(intent);

  const simulation = await simulateManagedSwap(args.apiKey, quote.id, args.walletAddress);
  if (!simulation.wouldExecute) {
    const warningText = simulation.warnings.length > 0 ? `: ${simulation.warnings.join("; ")}` : "";
    if (isNew && intent.phase === "prepared") {
      intent.phase = "failed";
      intent.error = `Simulation blocked execution${warningText}`;
    } else {
      intent.phase = "outcome_unknown";
      intent.error = `Retry simulation blocked while an earlier submission may have executed${warningText}`;
    }
    saveEntry(intent);
    return { intent, simulation };
  }

  // Persist the idempotency key and ambiguous in-flight state before the HTTP
  // request. A crash after this write is safely retried with the same key.
  intent.phase = "submitting";
  intent.error = undefined;
  saveEntry(intent);

  try {
    const swap = await executeManagedSwap(args.apiKey, quote.id, { idempotencyKey: intent.id });
    intent.swapId = swap.swapId;
    intent.swapStatus = swap.status;
    intent.txHash = swap.txHash;
    intent.phase = isSuccessfulSwapStatus(swap.status)
      ? "completed"
      : isFailedSwapStatus(swap.status)
        ? "failed"
        : "submitted";
    saveEntry(intent);

    // A terminal execute response still benefits from the status record because
    // it carries final from/to amounts. Never invent a fill from a quote.
    if (intent.swapId && intent.phase === "completed") {
      intent = await reconcileKnownSwap(args.apiKey, intent);
    }
  } catch (error) {
    if (error instanceof ManagedSwapRequestError && !error.outcomeUnknown) {
      intent.phase = "failed";
    } else {
      intent.phase = "outcome_unknown";
    }
    intent.error = error instanceof Error ? error.message : String(error);
    saveEntry(intent);
  }

  return { intent, simulation };
}
