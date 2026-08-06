/**
 * Managed-wallet execution bridge.
 *
 * The published @suwappu/sdk 0.4.x used by this example predates the managed
 * swap helpers now present in suwappubot main, so live execution calls the
 * current REST endpoint directly. Keep quote construction in the stable SDK
 * and keep the execution boundary explicit in one place.
 */
const API_BASE_URL = process.env.SUWAPPU_API_URL ?? "https://api.suwappu.bot";

export interface ManagedSwapResult {
  swapId: string;
  status: string;
  txHash?: string;
  pollUrl?: string;
}

interface ManagedSwapResponse {
  swap_id?: string | number;
  status?: string;
  tx_hash?: string | null;
  tracking?: { poll_url?: string };
  error?: string;
  message?: string;
}

export async function executeManagedSwap(
  apiKey: string,
  quoteId: string,
): Promise<ManagedSwapResult> {
  if (!apiKey) {
    throw new Error("SUWAPPU_API_KEY is required for managed execution");
  }

  const response = await fetch(`${API_BASE_URL}/v1/agent/swap/execute`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ quote_id: quoteId }),
  });

  const body = (await response.json()) as ManagedSwapResponse;
  if (!response.ok) {
    throw new Error(body.error ?? body.message ?? `Swap execution failed (${response.status})`);
  }
  if (body.swap_id === undefined || typeof body.status !== "string") {
    throw new Error("Malformed managed swap response");
  }

  return {
    swapId: String(body.swap_id),
    status: body.status,
    ...(body.tx_hash ? { txHash: body.tx_hash } : {}),
    ...(body.tracking?.poll_url ? { pollUrl: body.tracking.poll_url } : {}),
  };
}
