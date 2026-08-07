# Suwappu Flywheel

A standalone strategy-operations product and builder kit for [Suwappu](https://suwappu.bot). Flywheel gives power users a paper-first CLI/TUI for market screens, DCA/grid/scalper workflows, portfolio analysis, and explicit managed-wallet execution with a durable intent journal.

> **Safety:** scan/paper mode is the default. Live DCA, grid, and scalper actions require `--execute`. Enterprise-operable does not mean security-audited or profitable, and nothing here is financial advice. Use a dedicated test agent/wallet and conservative policies before putting real value at risk.

## What the product does

Flywheel is deliberately smaller than a full trading framework. It is useful directly as a single-operator strategy workspace and as production-oriented reference code for a larger Suwappu product:

| Builder pattern | Where to look | Money-moving by default? |
|---|---|---|
| Quotes + market data | `src/strategies/dca.ts`, `src/strategies/arb.ts` | No |
| Lending + prediction data | `src/strategies/yield.ts`, `src/strategies/predict.ts` | No |
| Durable managed execution | `src/execution.ts`, `src/suwappu.ts` | Only behind `--execute` |
| DCA + take-profit composition | `src/strategies/dca.ts`, `src/strategies/grid.ts` | Paper/check by default |
| Paper vs live scalper state | `src/scalper.ts` | Separate ledgers |
| Risk/evaluation state | `src/portfolio.ts`, `src/brain/` | Local computation |
| Fail-closed durable state | `src/storage.ts` | Protects local ledgers from silent reset |
| Operations / incident recovery | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Operator control plane |
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

If you need a mature exchange-trading framework, use one. [Freqtrade](https://www.freqtrade.io/en/stable/strategy-customization/) runs the same strategy concept through backtesting, dry/forward testing, and live modes and also ships a [lookahead-bias analysis](https://www.freqtrade.io/en/stable/lookahead-analysis/). [Hummingbot](https://hummingbot.org/docs/) provides a broader connector/strategy platform whose V2 controllers support backtesting and multi-bot deployment.

Flywheel is not trying to duplicate those projects. It is the compact Suwappu-specific layer to study when you need Suwappu market surfaces and managed execution in your own app.

| Capability | Flywheel | Mature trading frameworks |
|---|---|---|
| Suwappu quotes/data/managed-wallet patterns | Primary purpose | Not their purpose |
| Safe paper/read-only starting point | Yes | Yes |
| Durable Suwappu intent + reconciliation example | Yes | N/A |
| Historical backtesting engine | No | Common |
| Exchange connector framework | No | Common |
| Fill/order database + production observability | Durable single-writer journal + metadata events | Much deeper |

Treat Flywheel's strategy results as examples to evaluate, not evidence of a profitable strategy.

## Quick start

Requirements: [Bun](https://bun.sh) 1.3.14+ (CI is pinned to 1.3.14).

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

### Docker

The container runs as a non-root user, mounts the named `flywheel_state` volume
at `/data`, runs one paper/read-only Flywheel cycle, and then exits. Compose
does not restart it automatically. The named volume is important: execution
intents must survive `docker compose run --rm` so a retry cannot forget its
idempotency key.

```bash
docker compose run --rm flywheel

# Deliberate live opt-in; configure managed-wallet policies first.
docker compose run --rm flywheel bun run src/cli.ts run --execute
```

For scheduled automation, keep scheduling outside the container and make the
live opt-in explicit on every configured job. `run-dca.sh` follows the same
rule: it is paper/read-only unless you pass `--execute`. Back up the state
volume before live upgrades; do not remove the volume while unresolved intents
exist. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

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
- DCA learning records a later observed price (15m, then 1h, then 24h as those windows mature). Kelly/attribution uses the most mature observed return, never the entry-price quote discrepancy as if it were later P&L.
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
- HTTP 408, transport failure, timeout, 5xx, or a malformed managed-execution success are outcome-unknown after submission begins.
- DCA and scalper buys are capped by `SUWAPPU_MAX_TRADE_USD` (default `1000`) unless you deliberately change it; invalid live cap configuration fails closed.
- The scalper never invents an account balance for Kelly sizing. Set `SUWAPPU_SCALPER_USDC_BUDGET` only when you want percentage sizing against an explicit strategy budget.
- The scalper has hourly-trade, daily-loss, cooldown, and stop guards. They are example controls, not guarantees.
- Existing financial state is never silently replaced when JSON is corrupt. Authoritative state files are atomically replaced with restrictive file permissions.
- Run one live writer per state directory/volume. Managed submission takes an exclusive local `execution.lock` so an overlapping writer fails closed; this is still not a distributed lock/database or a scheduler-level dedupe key.
- Keep API keys out of git. Use separate agents/wallets and conservative limits while developing.

For managed REST calls, Flywheel uses a 25-second operation deadline by default (`SUWAPPU_OPERATION_TIMEOUT_MS`, max 30 seconds). Set `SUWAPPU_API_EVENTS=1` to emit metadata-only operation/outcome/duration/status events to stderr; these events exclude credentials, wallet addresses, quote/swap IDs, bodies, and error messages.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

CI pins Bun, runs typecheck/tests/build/CLI smoke checks, audits high/critical dependency advisories, validates/builds the container contract, and runs CodeQL. Execution tests cover idempotent retry, pending-swap reconciliation, 408 ambiguity, corrupt-journal fail-closed behavior, and quote-vs-final amount separation.

## Links

- [Suwappu](https://suwappu.bot)
- [Suwappu docs](https://docs.suwappu.bot)
- [Published TypeScript SDK](https://www.npmjs.com/package/@suwappu/sdk)
- [Suwappu SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [Freqtrade strategy docs](https://www.freqtrade.io/en/stable/strategy-101/)
- [Hummingbot](https://github.com/hummingbot/hummingbot)

## License

MIT
