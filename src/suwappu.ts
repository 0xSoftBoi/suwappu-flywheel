/**
 * Current managed-wallet REST bridge.
 *
 * The published SDK used by this repo predates these helpers. Keep the raw
 * HTTP contract here so strategy code does not blur quote preparation with
 * the money-moving managed execution boundary.
 */
const API_BASE_URL = process.env.SUWAPPU_API_URL ?? "https://api.suwappu.bot";
const DEFAULT_OPERATION_TIMEOUT_MS = 25_000;
const MAX_OPERATION_TIMEOUT_MS = 30_000;

export function operationTimeoutMs(): number {
  const raw = process.env.SUWAPPU_OPERATION_TIMEOUT_MS ?? String(DEFAULT_OPERATION_TIMEOUT_MS);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 100 || value > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error("SUWAPPU_OPERATION_TIMEOUT_MS must be between 100 and 30000 milliseconds");
  }
  return value;
}

function emitApiEvent(
  operation: string,
  outcome: "success" | "http_error" | "protocol_error" | "timeout" | "network_error",
  startedAt: number,
  status?: number,
): void {
  if (!/^(1|true)$/i.test(process.env.SUWAPPU_API_EVENTS ?? "")) return;
  const event: Record<string, string | number> = {
    operation,
    outcome,
    duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
  };
  if (status !== undefined) event.status = status;
  // Deliberately no credentials, wallet addresses, quote/swap IDs, request or
  // response bodies, error messages, or strategy inputs.
  console.error(`suwappu_api_event ${JSON.stringify(event)}`);
}

async function fetchWithDeadline(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(operationTimeoutMs()),
  });
}

export interface ManagedSwapResult {
  swapId: string;
  status: string;
  txHash?: string;
  pollUrl?: string;
}

export interface ManagedSwapStatus {
  swapId: string;
  status: string;
  txHash?: string;
  fromChain?: string;
  toChain?: string;
  fromToken?: string;
  toToken?: string;
  fromAmount?: string;
  toAmount?: string;
  errorMessage?: string;
  createdAt?: string;
  completedAt?: string;
}

export interface ManagedSwapSimulation {
  wouldExecute: boolean;
  quoteId: string;
  warnings: string[];
  checks: Array<{ name: string; status: string; detail: string }>;
}

interface ErrorBody {
  error?: string;
  message?: string;
  detail?: string;
}

interface ManagedSwapResponse extends ErrorBody {
  swap_id?: string | number;
  status?: string;
  tx_hash?: string | null;
  tracking?: { poll_url?: string };
}

interface ManagedSwapStatusResponse extends ErrorBody {
  swap_id?: string | number;
  status?: string;
  tx_hash?: string | null;
  from_chain?: string;
  to_chain?: string;
  from_token?: string;
  to_token?: string;
  from_amount?: string;
  to_amount?: string | null;
  error_message?: string | null;
  created_at?: string;
  completed_at?: string | null;
}

interface SimulationResponse extends ErrorBody {
  quote_id?: string;
  would_execute?: boolean;
  warnings?: unknown[];
  checks?: Array<{ name?: unknown; status?: unknown; detail?: unknown }>;
}

export class ManagedSwapRequestError extends Error {
  readonly httpStatus?: number;
  readonly outcomeUnknown: boolean;

  constructor(message: string, options: { httpStatus?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = "ManagedSwapRequestError";
    this.httpStatus = options.httpStatus;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

function errorMessage(body: ErrorBody, fallback: string): string {
  return body.error ?? body.message ?? body.detail ?? fallback;
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}

export function isSuccessfulSwapStatus(status: string): boolean {
  return ["completed", "confirmed"].includes(status.toLowerCase());
}

export function isFailedSwapStatus(status: string): boolean {
  return status.toLowerCase() === "failed";
}

export async function simulateManagedSwap(
  apiKey: string,
  quoteId: string,
  walletAddress?: string,
): Promise<ManagedSwapSimulation> {
  if (!apiKey) throw new Error("SUWAPPU_API_KEY is required for swap simulation");

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetchWithDeadline(`${API_BASE_URL}/v1/agent/swap/simulate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quote_id: quoteId,
        ...(walletAddress ? { wallet_address: walletAddress } : {}),
      }),
    });
  } catch (error) {
    const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    emitApiEvent("simulate_swap", timeout ? "timeout" : "network_error", startedAt);
    throw new ManagedSwapRequestError(
      `Swap simulation ${timeout ? "timed out" : "transport failed"}`,
    );
  }
  const body = await readJson<SimulationResponse>(response);
  if (!response.ok) {
    emitApiEvent("simulate_swap", "http_error", startedAt, response.status);
    throw new ManagedSwapRequestError(
      errorMessage(body, `Swap simulation failed (${response.status})`),
      { httpStatus: response.status },
    );
  }

  if (typeof body.would_execute !== "boolean" || !body.quote_id) {
    emitApiEvent("simulate_swap", "protocol_error", startedAt, response.status);
    throw new ManagedSwapRequestError("Malformed swap simulation response");
  }
  emitApiEvent("simulate_swap", "success", startedAt, response.status);

  return {
    wouldExecute: body.would_execute,
    quoteId: body.quote_id,
    warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : [],
    checks: Array.isArray(body.checks)
      ? body.checks.map((check) => ({
          name: String(check.name ?? ""),
          status: String(check.status ?? ""),
          detail: String(check.detail ?? ""),
        }))
      : [],
  };
}

export async function executeManagedSwap(
  apiKey: string,
  quoteId: string,
  options: { idempotencyKey: string },
): Promise<ManagedSwapResult> {
  if (!apiKey) throw new Error("SUWAPPU_API_KEY is required for managed execution");
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(options.idempotencyKey)) {
    throw new Error("idempotencyKey must be 1-64 characters using A-Z, a-z, 0-9, _, ., :, or -");
  }

  let response: Response;
  const startedAt = performance.now();
  try {
    response = await fetchWithDeadline(`${API_BASE_URL}/v1/agent/swap/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify({ quote_id: quoteId }),
    });
  } catch (error) {
    const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    emitApiEvent("execute_managed_swap", timeout ? "timeout" : "network_error", startedAt);
    throw new ManagedSwapRequestError(
      `Managed swap ${timeout ? "timed out" : "transport failed"}`,
      { outcomeUnknown: true },
    );
  }

  const body = await readJson<ManagedSwapResponse>(response);
  if (!response.ok) {
    emitApiEvent("execute_managed_swap", "http_error", startedAt, response.status);
    throw new ManagedSwapRequestError(
      errorMessage(body, `Swap execution failed (${response.status})`),
      { httpStatus: response.status, outcomeUnknown: response.status === 408 || response.status >= 500 },
    );
  }
  if (body.swap_id === undefined || typeof body.status !== "string") {
    emitApiEvent("execute_managed_swap", "protocol_error", startedAt, response.status);
    throw new ManagedSwapRequestError("Malformed managed swap response", { outcomeUnknown: true });
  }
  emitApiEvent("execute_managed_swap", "success", startedAt, response.status);

  return {
    swapId: String(body.swap_id),
    status: body.status,
    ...(body.tx_hash ? { txHash: body.tx_hash } : {}),
    ...(body.tracking?.poll_url ? { pollUrl: body.tracking.poll_url } : {}),
  };
}

export async function getManagedSwapStatus(
  apiKey: string,
  swapId: string,
): Promise<ManagedSwapStatus> {
  if (!apiKey) throw new Error("SUWAPPU_API_KEY is required for swap reconciliation");
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetchWithDeadline(`${API_BASE_URL}/v1/agent/swap/status/${encodeURIComponent(swapId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    emitApiEvent("get_swap_status", timeout ? "timeout" : "network_error", startedAt);
    throw new ManagedSwapRequestError(
      `Swap reconciliation ${timeout ? "timed out" : "transport failed"}`,
    );
  }
  const body = await readJson<ManagedSwapStatusResponse>(response);
  if (!response.ok) {
    emitApiEvent("get_swap_status", "http_error", startedAt, response.status);
    throw new ManagedSwapRequestError(
      errorMessage(body, `Swap status failed (${response.status})`),
      { httpStatus: response.status },
    );
  }
  if (body.swap_id === undefined || typeof body.status !== "string") {
    emitApiEvent("get_swap_status", "protocol_error", startedAt, response.status);
    throw new ManagedSwapRequestError("Malformed managed swap status response");
  }
  emitApiEvent("get_swap_status", "success", startedAt, response.status);

  return {
    swapId: String(body.swap_id),
    status: body.status,
    ...(body.tx_hash ? { txHash: body.tx_hash } : {}),
    ...(body.from_chain ? { fromChain: body.from_chain } : {}),
    ...(body.to_chain ? { toChain: body.to_chain } : {}),
    ...(body.from_token ? { fromToken: body.from_token } : {}),
    ...(body.to_token ? { toToken: body.to_token } : {}),
    ...(body.from_amount ? { fromAmount: body.from_amount } : {}),
    ...(body.to_amount ? { toAmount: body.to_amount } : {}),
    ...(body.error_message ? { errorMessage: body.error_message } : {}),
    ...(body.created_at ? { createdAt: body.created_at } : {}),
    ...(body.completed_at ? { completedAt: body.completed_at } : {}),
  };
}
