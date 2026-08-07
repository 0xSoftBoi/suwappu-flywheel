# Operating Suwappu Flywheel

Flywheel 2.x is a standalone, single-writer strategy-operations service/CLI. Its safety contract is more important than any included signal: an intent is durable before managed submission, ambiguous submissions are reconciled, and only terminal final amounts feed accounting.

This runbook describes the supported production boundary. It is not a security certification, investment-performance claim, or substitute for the controls required by your organization.

## Deployment boundary

One Flywheel deployment should own one Suwappu agent/wallet and one durable state directory. Treat that directory as financial operational state, not disposable cache.

Authoritative files include:

- `execution-journal.json` — economic intent, idempotency, submission, reconciliation, accounting acknowledgement;
- `dca-history.json` — confirmed DCA inventory only;
- `grid-state.json` — confirmed grid inventory/sells;
- `scalper-live-state.json` — live scalper position and realized results;
- `state.json` — strategy learning/risk observations.

Existing JSON that cannot be parsed or does not match the minimum expected shape fails closed. Flywheel will not silently replace it with an empty ledger. Writes use a temporary file, file `fsync`, atomic rename, restrictive file permissions, and a best-effort directory `fsync`.

The local store is intentionally **single writer**. Each managed submission acquires `execution.lock` with exclusive-create semantics; an overlapping writer fails closed before it can quote/simulate/submit through the coordinator. This protects accidental local overlap, but it is not a distributed lock or scheduler-level job-deduplication system. A multi-worker SaaS should move the economic-intent state machine into a transactional database with a unique intent/idempotency constraint, locking or leases, and an append-only audit trail.

An abnormal process/container death can deliberately leave `execution.lock` behind. That is a safety stop, not cache garbage: stop all live writers, inspect/reconcile the execution journal (the reconciliation command remains available), and only then clear a proven-stale lock. Never delete the journal to get past the lock.

## Container persistence

Compose mounts the named `flywheel_state` volume at `/data` and sets `SUWAPPU_FLYWHEEL_STATE_DIR=/data`. The image runs as the non-root `bun` user. `docker compose run --rm` removes the container but preserves that named volume.

Before a live upgrade:

1. stop the live writer;
2. run `executions --reconcile` until every resolvable submitted/unknown intent has been checked;
3. snapshot/back up the state volume;
4. deploy the new image in paper/read-only mode first;
5. verify the same state is visible; and
6. explicitly restore `--execute` only after the canary is healthy.

Do not delete/recreate the volume to fix a deployment problem. Losing an unresolved idempotency key can turn a retry into a second economic action.

## Managed request contract

Direct managed REST calls have a 25-second operation deadline by default. `SUWAPPU_OPERATION_TIMEOUT_MS` accepts `100..30000`; an invalid value fails instead of silently disabling the deadline.

Set `SUWAPPU_API_EVENTS=1` to emit a metadata-only stderr event per managed simulation, submission, or reconciliation request. Fields are limited to operation, outcome, duration, and optional HTTP status. The event deliberately excludes API keys, wallets, quote/swap IDs, strategy terms, request/response bodies, and error messages.

Add deployment/tenant/run correlation in your logging layer. Do not turn wallets or financial identifiers into high-cardinality metric labels.

## Failure and retry matrix

| Operation/result | Operator rule |
|---|---|
| Market/discovery read | Bounded retry is acceptable if the strategy tolerates staleness |
| Quote failure | Get a fresh quote; do not treat a failed/stale quote as evidence |
| Simulation failure | No managed submission has happened; retry as a fresh preflight |
| Managed execute known 4xx other than 408 | Known rejection; fix the cause before a new attempt |
| Managed execute timeout/network/408/5xx | **Outcome unknown**; preserve the intent/key and reconcile before replacement |
| Managed execute malformed successful response | **Outcome unknown**; preserve the intent/key and reconcile |
| Known `swap_id` | Poll status; do not submit another action |
| Terminal success without final amounts | Keep accounting on hold and reconcile again |

Do not put a generic retry decorator around the money-moving path.

## State and learning semantics

A completed trade and a strategy evaluation are different facts.

- DCA/grid inventory is created only from reconciled terminal-success final amounts.
- A DCA buy has no later strategy return at fill time. Flywheel records a later observed market price as the 15m, 1h, and then 24h evaluation windows mature.
- Kelly/strategy attribution uses the most mature observed return. It does not call entry-price slippage “P&L.”
- Paper and live scalper ledgers remain separate.
- Portfolio `maxObservedDrawdown` means the worst drawdown Flywheel actually observed while updating portfolio state; it is not a historical-backtest maximum.
- VaR/Sharpe/Sortino are estimates over the available evaluated trade-return observations, not guarantees or institutional risk-model replacements.

For rigorous strategy promotion, use historical replay plus lookahead-bias checks, live paper/forward testing, capped live execution, and only then scaled live automation.

## Limits and policy

Live DCA and scalper buys use `SUWAPPU_MAX_TRADE_USD` (default `1000`). Invalid live-cap configuration fails closed. Keep the application cap below or equal to the managed-wallet policy you intend to enforce server-side.

The scalper applies Kelly percentage sizing only when `SUWAPPU_SCALPER_USDC_BUDGET` contains a real operator-defined strategy budget. Without it, the requested `--amount` is the budget ceiling; Flywheel never invents a wallet balance.

Arbitrage is screening-only because this product does not implement a reconciled bridge + second-leg + unwind workflow. Prediction price sums and lending APYs are screens/snapshots, not executable profit promises.

## SLOs and alerts

Choose thresholds from your customer promise. At minimum track:

- operation success/error/latency by operation (from metadata events);
- simulations blocked or warned;
- submitted, outcome-unknown, reconciled, completed, and failed intent counts;
- oldest unresolved-intent age;
- duplicate economic actions (target: zero);
- state-file failures and failed backups;
- paper/live strategy errors separately;
- variable API/data/compute cost per active customer or workflow;
- dependency audit, CodeQL, test, build, and container gate status.

Page an operator when unresolved intent age grows, state cannot be loaded, live submissions appear without a persisted intent, or repeated transport/protocol failures make the financial outcome ambiguous.

## Release gates

Before promotion, CI must pass:

1. TypeScript typecheck;
2. behavior/regression tests;
3. Bun build of CLI/TUI/scalper entrypoints;
4. CLI help smoke contract;
5. high/critical dependency audit;
6. Compose validation and Docker image build; and
7. CodeQL analysis.

For a live release, additionally run a paper canary against the intended API environment, verify the durable state/backup path, inspect unresolved intents, and verify server-side wallet policies and kill/disable controls.

## Live-money incident runbook

If submission outcomes become ambiguous:

1. disable new live strategy submissions (remove the scheduler or `--execute` invocation);
2. preserve the state directory/volume and original idempotency keys;
3. keep read/status access available;
4. run `bun run src/cli.ts executions --reconcile` for known swaps;
5. reconcile each unresolved intent before creating a replacement economic action;
6. restore from backup only if you have established that the backup is newer/safer than the current financial ledger; and
7. resume live submissions with a capped canary only after the failure mode is understood.

If an API key may be exposed, stop new execution, rotate/replace authority through the proper control plane, and still reconcile trades that may already have been submitted.

If a state file is corrupt, **do not delete it and rerun**. Stop the writer, preserve the bad file, compare it with the latest known-good backup and the Suwappu execution/status history, reconstruct authoritative intent/accounting state, and only then resume.

## Multi-tenant graduation

The repository is a standalone single-tenant deployment. To sell it as a multi-tenant service, add authenticated tenant context outside strategy code and isolate credentials, wallet policy, budgets, queues, database rows, logs, backups, and billing per tenant. Reserve reconciliation capacity so normal analysis traffic cannot starve the requests needed to determine whether money already moved.

Keep customer strategy P&L in a separate ledger from builder revenue/cost. The business can create value through monitoring, approvals, reporting, audit history, and automation without promising that an included trading signal will make money.
