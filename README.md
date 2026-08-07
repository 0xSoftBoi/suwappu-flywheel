# Suwappu Flywheel

A strategy lab and builder reference for [Suwappu](https://suwappu.bot). It shows how to combine quotes, prices, lending, prediction markets, local strategy state, paper trading, and explicit managed-wallet execution without teaching that a submitted transaction is already a fill.

> **Safety:** scan/paper mode is the default. Live DCA, grid, and scalper actions require `--execute`. This repository is an example, not financial advice, and is not audited. Use a separate test wallet and conservative policies before putting real value at risk.

## Why this repo exists

Flywheel is deliberately smaller than a full trading framework. Its job is to make Suwappu integration patterns easy to copy into a product:

| Builder pattern | Where to look | Money-moving by default? |
|---|---|---|
| Quotes + market data | `src/strategies/dca.ts`, `src/strategies/arb.ts` | No |
| Lending + prediction data | `src/strategies/yield.ts`, `src/strategies/predict.ts` | No |
| Durable managed execution | `src/execution.ts`, `src/suwappu.ts` | Only behind `--execute` |
| DCA + take-profit composition | `src/strategies/dca.ts`, `src/strategies/grid.ts` | Paper/check by default |
| Paper vs live scalper state | `src/scalper.ts` | Separate ledgers |
| Risk/evaluation state | `src/portfolio.ts`, `src/brain/` | Local computation |
| Turn the patterns into a product | [`BUILDING_A_PRODUCT.md`](BUILDING_A_PRODUCT.md) | Start read-only |

The live lifecycle is intentionally explicit:

1. make one economic decision;
2. obtain a fresh quote;
3. simulate it with `POST /v1/agent/swap/simulate`;
4. persist one durable `Idempotency-Key` **before** submission;
5. submit through `POST /v1/agent/swap/execute`;
6. reconcile the returned `swap_id` through `GET /v1/agent/swap/status/:id`;
7. only after terminal success update holdings, P&L, history, or learning state.

A timeout/5xx can leave the on-chain outcome unknown. Flywheel reuses the persisted intent instead of minting a replacement trade. `src/execution.ts` is the reference implementation of that boundary.

## Where this fits vs mature trading OSS

If you need a mature exchange-trading framework, use one. [Freqtrade](https://www.freqtrade.io/en/stable/strategy-101/) documents backtesting, dry-run/forward testing, and strategy analysis; [Hummingbot](https://github.com/hummingbot/hummingbot) provides a broader algorithmic-trading framework and connector ecosystem.

Flywheel is not trying to duplicate those projects. It is the compact Suwappu-specific layer to study when you need Suwappu market surfaces and managed execution in your own app.

| Capability | Flywheel | Mature trading frameworks |
|---|---|---|
| Suwappu quotes/data/managed-wallet patterns | Primary purpose | Not their purpose |
| Safe paper/read-only starting point | Yes | Yes |
| Durable Suwappu intent + reconciliation example | Yes | N/A |
| Historical backtesting engine | No | Common |
| Exchange connector framework | No | Common |
| Fill/order database + production observability | Reference journal only | Much deeper |

Treat Flywheel's strategy results as examples to evaluate, not evidence of a profitable strategy.

## Quick start

Requirements: [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/0xSoftBoi/suwappu-flywheel.git
cd suwappu-flywheel
bun install --frozen-lockfile

# Register an agent. The API key is returned once; store it securely.
curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-flywheel"}'

export SUWAPPU_API_KEY=suwappu_sk_...

# Safe default: inspect/quote/paper trade, do not move funds.
bun run src/cli.ts run
```

You do not need a private key in this project.

## Commands

| Command | Purpose | Live action |
|---|---|---|
| `yield` | Rank lending-market APY snapshots | None |
| `dca` | Quote/paper a DCA buy | `--execute` |
| `arb` | Screen cross-chain price spreads with an estimate-only cost model | None |
| `predict` | Screen YES+NO price-sum deviations | None |
| `grid` | Check take-profit levels | `--execute` |
| `status` | API/wallet dashboard | None |
| `executions` | Inspect the durable execution journal; `--reconcile` only polls known swaps | None |
| `watch` | Repeat read-only market scans | None |
| `portfolio` | Local risk/strategy report | None |
| `run` | Run the DCA + grid reference workflow | `--execute` |
| `scalp` | Run the mean-reversion paper/live example | `--execute` |
| `tui` | Interactive view over the same workflows | `--execute` |

Examples:

```bash
# DCA — quote/paper unless --execute is present
bun run src/cli.ts dca --token ETH --amount 10
bun run src/cli.ts dca --token ETH --amount 5 --fear-adjust
bun run src/cli.ts dca --token ETH --amount 5 --execute

# Read-only scanners
bun run src/cli.ts yield --top 5 --min-apy 5
bun run src/cli.ts arb --tokens ETH,SOL --chains base,arbitrum,optimism
bun run src/cli.ts predict --top 10
bun run src/cli.ts watch --interval 300

# Grid + composed flywheel
bun run src/cli.ts grid
bun run src/cli.ts grid --execute
bun run src/cli.ts run
bun run src/cli.ts run --execute

# See intent/submission/finality separately
bun run src/cli.ts executions
bun run src/cli.ts executions --reconcile

# Paper and live scalper state are intentionally separate
bun run src/cli.ts scalp --amount 2
bun run src/cli.ts scalp --amount 2 --execute

# TUI is also paper/read-only unless explicitly opted into live mode
bun run src/tui.ts
bun run src/tui.ts --execute
```

Use `--json` on commands that expose it when another service will consume the result.

## Managed execution and custody

Flywheel's live paths use Suwappu-managed wallets:

```bash
curl -X POST https://api.suwappu.bot/v1/agent/wallets \
  -H "Authorization: Bearer $SUWAPPU_API_KEY"
```

Configure wallet policies before funding or enabling live strategies. If you know the managed wallet address, `SUWAPPU_MANAGED_WALLET_ADDRESS` lets the preflight simulation run wallet-dependent checks. It is optional; it is not a private key.

`WALLET_ADDRESS` has a different purpose in this example: portfolio/balance monitoring. Do not confuse an observation address with execution authority.

For self-custody, use `POST /v1/agent/swap` to prepare an **unsigned** transaction and sign it in your own wallet. Flywheel intentionally does not embed local private-key signing.

## Evaluation: what the numbers mean

- The scalper's default mode is **paper**, and paper state lives in `scalper-paper-state.json`. Live state lives separately in `scalper-live-state.json`.
- Paper exits use a fresh Suwappu quote. They are still simulations, not observed fills.
- DCA/grid accounting consumes only reconciled terminal successes and final status amounts. Quote output is preserved as an estimate, not relabeled as a fill.
- Pre-upgrade DCA/grid rows were recorded at submission time and therefore cannot prove finality. The current code excludes those legacy rows from verified accounting instead of silently trusting them.
- The arb scanner's bridge/gas/slippage model is a **screening estimate**. It does not model an atomic two-leg workflow, so live arb execution is intentionally disabled.
- Prediction `YES + NO` deviation is a screening signal, not guaranteed arbitrage; spread, fees, stale books, and execution matter.
- Lending APY is a snapshot, not a guaranteed return.
- `src/brain/` is an example feedback loop over observed/reference data. It is not a substitute for historical backtesting, walk-forward validation, or a production risk engine.

This separation is intentional: a useful developer example should make it hard to accidentally train on invented outcomes.

## Build something people pay for

Trading profit is uncertain. Product revenue is a different problem. A lower-risk builder path is:

1. ship a read-only scanner/report/alert people use repeatedly;
2. measure first useful quote/report and weekly return usage;
3. charge for workflow value (alerts, saved strategies, reporting, team controls);
4. add simulation and approvals;
5. add managed automation only when users explicitly need it.

[`BUILDING_A_PRODUCT.md`](BUILDING_A_PRODUCT.md) turns that into concrete MVPs, metrics, authority boundaries, and contribution-margin math.

## SDK version boundary

As of this repository update, npm publishes `@suwappu/sdk@0.4.0`. The `suwappubot` monorepo contains 0.6.0 source APIs including managed execution, simulation, self-custody preparation, wallets, policies, approvals, audit, and kill-switch helpers.

Until 0.6.x is published, Flywheel keeps quote construction on the installable SDK and isolates the newer current REST contracts in `src/suwappu.ts`. That is deliberate: examples should install today rather than depend on an unpublished package version.

## Safety boundaries

- No CLI strategy trades merely because an API key exists; live DCA/grid/scalper paths require `--execute`.
- Every fresh live quote is simulated before submission.
- Every live intent persists a server-compatible idempotency key before submission.
- Known pending swaps are reconciled instead of resubmitted.
- Outcome-unknown requests keep the same intent; do not create a replacement economic action.
- DCA CLI orders are capped by `SUWAPPU_MAX_TRADE_USD` (default `1000`) unless you deliberately change it.
- The scalper has hourly-trade, daily-loss, cooldown, and stop guards. They are example controls, not guarantees.
- Run one live worker per local state directory; the JSON journal is a reference implementation, not a distributed lock/database.
- Keep API keys out of git. Use separate agents/wallets and conservative limits while developing.

## Development

```bash
bun install --frozen-lockfile
bun run check
bun test
```

CI uses pinned Bun and runs the same typecheck/tests without `|| true`. The execution tests cover idempotent retry, pending-swap reconciliation, and quote-vs-final amount separation.

## Links

- [Suwappu](https://suwappu.bot)
- [Suwappu docs](https://docs.suwappu.bot)
- [Published TypeScript SDK](https://www.npmjs.com/package/@suwappu/sdk)
- [Suwappu SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [Freqtrade strategy docs](https://www.freqtrade.io/en/stable/strategy-101/)
- [Hummingbot](https://github.com/hummingbot/hummingbot)

## License

MIT
