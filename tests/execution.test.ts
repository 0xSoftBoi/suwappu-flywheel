import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runManagedExecution } from "../src/execution";

const originalFetch = globalThis.fetch;
let testStateDir = "";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  testStateDir = mkdtempSync(join(tmpdir(), "suwappu-flywheel-test-"));
  process.env.SUWAPPU_FLYWHEEL_STATE_DIR = testStateDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SUWAPPU_FLYWHEEL_STATE_DIR;
  rmSync(testStateDir, { recursive: true, force: true });
});

describe("durable managed execution", () => {
  it("reuses the same idempotency key after an outcome-unknown network error", async () => {
    let executeCalls = 0;
    let quoteCalls = 0;
    const idempotencyKeys: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({ success: true, would_execute: true, quote_id: `q${quoteCalls}` });
      }
      if (url.endsWith("/swap/execute")) {
        executeCalls++;
        const headers = new Headers(init?.headers);
        idempotencyKeys.push(headers.get("Idempotency-Key") ?? "");
        if (executeCalls === 1) throw new TypeError("connection reset after request");
        return jsonResponse({ swap_id: 42, status: "pending", tx_hash: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const run = () => runManagedExecution({
      apiKey: "test-key",
      strategy: "dca",
      actionKey: "buy",
      terms: { fromToken: "USDC", toToken: "ETH", amount: "5", chain: "base" },
      getQuote: async () => {
        quoteCalls++;
        return { id: `q${quoteCalls}`, toAmount: "0.002" };
      },
    });

    const first = await run();
    expect(first.intent.phase).toBe("outcome_unknown");
    const second = await run();
    expect(second.intent.phase).toBe("submitted");
    expect(second.intent.id).toBe(first.intent.id);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  });

  it("polls a known swap instead of submitting a second economic action", async () => {
    let executeCalls = 0;
    let quoteCalls = 0;
    let statusCalls = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({ success: true, would_execute: true, quote_id: "q1" });
      }
      if (url.endsWith("/swap/execute")) {
        executeCalls++;
        return jsonResponse({ swap_id: 7, status: "pending", tx_hash: null });
      }
      if (url.endsWith("/swap/status/7")) {
        statusCalls++;
        return jsonResponse({
          swap_id: 7,
          status: "pending",
          from_amount: "5",
          to_amount: null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const run = () => runManagedExecution({
      apiKey: "test-key",
      strategy: "grid",
      actionKey: "level.0",
      terms: { fromToken: "ETH", toToken: "USDC", amount: "0.002", chain: "base" },
      getQuote: async () => {
        quoteCalls++;
        return { id: "q1", toAmount: "5" };
      },
    });

    await run();
    const reconciled = await run();
    expect(reconciled.intent.phase).toBe("submitted");
    expect(executeCalls).toBe(1);
    expect(quoteCalls).toBe(1);
    expect(statusCalls).toBe(1);
  });

  it("exposes reconciled amounts only after terminal success", async () => {
    let status = "pending";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/swap/simulate")) {
        return jsonResponse({ success: true, would_execute: true, quote_id: "q-final" });
      }
      if (url.endsWith("/swap/execute")) {
        return jsonResponse({ swap_id: 99, status: "pending", tx_hash: null });
      }
      if (url.endsWith("/swap/status/99")) {
        return jsonResponse({
          swap_id: 99,
          status,
          tx_hash: status === "completed" ? "0xabc" : null,
          from_amount: "5",
          to_amount: status === "completed" ? "0.0021" : null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const run = () => runManagedExecution({
      apiKey: "test-key",
      strategy: "dca",
      actionKey: "buy",
      terms: { fromToken: "USDC", toToken: "ETH", amount: "5", chain: "base" },
      getQuote: async () => ({ id: "q-final", toAmount: "0.0022" }),
    });

    const submitted = await run();
    expect(submitted.intent.phase).toBe("submitted");
    expect(submitted.intent.actualToAmount).toBeUndefined();

    status = "completed";
    const completed = await run();
    expect(completed.intent.phase).toBe("completed");
    expect(completed.intent.actualToAmount).toBe("0.0021");
    expect(completed.intent.quotedToAmount).toBe("0.0022");
  });
});
