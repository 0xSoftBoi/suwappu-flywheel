# Build a Product on Suwappu, Not a Profit Promise

The most useful thing to copy from Flywheel is the product architecture, not any particular trading signal.

There are two separate economic questions:

1. **Does the user's strategy make money?** Unknown until it is rigorously evaluated; never promise this from a quote, APY snapshot, backtest, or paper run.
2. **Can your product make money?** Potentially, if customers repeatedly pay more for the workflow than it costs you to provide it.

This guide focuses on the second question while keeping the first honest.

## Start with the smallest authority surface

| Product | Customer value | Suwappu building blocks | Authority | Good first metric |
|---|---|---|---|---|
| Market scanner + alerts | Find things worth reviewing | prices, quotes, lending, prediction data | Read-only | User returns for another report/alert |
| Strategy workspace | Save rules, compare routes, paper decisions | quotes + local/server strategy state | Read-only | Saved rule used again within 7 days |
| Trade copilot | Turn a decision into a simulation + approval | quote, simulation, policies/approvals | User approves each action | Approved simulations / useful sessions |
| Managed automation | Run bounded recurring actions | managed wallet, simulation, execute, status/webhooks | Policy-bounded execution | Confirmed actions with zero duplicates |

The scanner is usually the fastest way to test willingness to pay because it creates useful output without asking a customer to delegate execution authority.

## Three concrete MVPs

### 1. Paid cross-chain opportunity monitor

Use the Flywheel arb scanner as a **screen**, not an execution claim.

MVP:

1. quote the same asset/size on selected chains;
2. show raw spread and a clearly labeled cost estimate;
3. let a user save a threshold;
4. send an alert when the screen crosses it;
5. link back to fresh quotes so the user can verify the opportunity.

Charge for workflow value such as more saved screens, faster monitoring, team delivery, history, or exports. Do not market a modeled spread as guaranteed net profit. Flywheel deliberately disables live arb because it does not implement the bridge + second leg + failure/unwind workflow.

### 2. DCA / treasury copilot

Use `src/strategies/dca.ts` and `src/execution.ts` as the starting contract.

MVP:

1. user defines token, chain, cadence, and maximum size;
2. product produces a fresh quote;
3. product simulates it;
4. user sees route/output/checks and approves;
5. product persists one intent/idempotency key;
6. product submits once and reconciles `swap_id`;
7. UI changes from **submitted** to **completed** only when the status record says so.

Paid tiers can add saved policies, multiple workspaces, reporting, webhooks, approval roles, or higher automation limits. Those are product capabilities; they do not require promising market returns.

### 3. Strategy operations console

Power users often need observability more than another signal. Build around the execution journal:

- decision / intent ID;
- quote ID and quote estimate;
- simulation checks and warnings;
- submission status;
- `swap_id` and transaction hash;
- final from/to amounts;
- failure or outcome-unknown state;
- who/what approved the action;
- whether downstream accounting consumed the final result.

That turns a bot into an auditable workflow and gives teams a reason to pay even when they already have strategy logic.

## The money-moving contract

Keep four concepts separate in your data model:

| State | What you know | What you may safely do |
|---|---|---|
| Decision | Strategy/user wants an action | Create an intent; no balance/P&L change |
| Quote + simulation | Current route estimate and preflight checks | Show preview; still no fill/accounting |
| Submitted / outcome unknown | Request may be in flight/on-chain | Reconcile; do **not** create a replacement intent |
| Completed | Status endpoint reports terminal success | Apply final amounts to holdings/accounting |

For managed execution, the relevant REST flow is:

```text
POST /v1/agent/quote
POST /v1/agent/swap/simulate
POST /v1/agent/swap/execute       # Idempotency-Key header
GET  /v1/agent/swap/status/:id
```

`src/execution.ts` persists the idempotency key before submission. If execution hits a timeout/network failure, HTTP 408/5xx, or malformed successful response, the same economic intent keeps the same key and is marked outcome-unknown. If a `swap_id` is already known, the code polls status instead of submitting again.

Flywheel 2.x makes local authoritative state fail closed on corruption and writes it atomically, but the local store is still **single writer**. In a production multi-worker service, move that journal to a transactional database with a unique economic-intent constraint and locking/leases. Durable files are not a distributed-systems claim.

## Evaluate before automating

Mature trading projects such as [Freqtrade](https://www.freqtrade.io/en/stable/strategy-customization/) run strategies through backtest, dry/forward-test, and live modes and provide a dedicated [lookahead-bias check](https://www.freqtrade.io/en/stable/lookahead-analysis/). [Hummingbot](https://hummingbot.org/docs/) provides deeper connector infrastructure, V2 controllers, backtesting, and multi-bot deployment. Flywheel does not replace those systems.

Before letting a strategy move funds unattended, keep an append-only decision dataset with:

- timestamp and strategy version;
- market inputs actually visible at decision time;
- intended economic terms;
- quote estimate and expiration;
- simulation result;
- paper/live mode;
- submitted intent and `swap_id` when live;
- final status and final amounts;
- fees/costs you can observe;
- reason for skip/rejection/failure.

Then answer concrete questions:

- Did the paper decision use only information available at that time?
- How different were quote estimates from confirmed outcomes?
- How often did simulations block an action?
- How many requests became outcome-unknown?
- Did any economic intent execute twice? (Target: zero.)
- Does a strategy still look useful after realistic costs and bad outcomes are included?

Do not mix paper and live ledgers. Flywheel's scalper now stores them separately for exactly this reason.

Do not call quote-time conversion loss a strategy return either. Flywheel's DCA learning waits for later market observations (15m, 1h, and 24h as those windows mature) and uses the most mature observed value for Kelly/attribution. For serious research, store the full time series and evaluate a declared horizon rather than selecting the best-looking one after the fact.

## Product metrics that matter

Avoid vanity metrics such as total API calls. Instrument the user journey:

### Activation

- time to first useful quote/report;
- percent of new users who save a rule or run a second useful query;
- percent who successfully simulate an intended action.

### Retention

- weekly users who return for another report/alert;
- saved strategies that are still active after 7/30 days;
- teams with repeated reconciled workflows.

### Execution quality

- simulation pass / warn / block rate;
- submission → completion rate;
- failure and outcome-unknown rate;
- reconciliation latency;
- duplicate economic actions (target: zero).

### Business economics

Keep customer revenue separate from trading P&L:

```text
monthly contribution margin
= subscription / usage revenue
- Suwappu API and transaction costs you absorb
- model / compute / data-provider costs
- hosting / observability costs
- payment processing
- variable support / refund costs
```

Track the same calculation per active customer and per paid plan. A high-volume feature can look popular while losing money if its variable cost exceeds incremental revenue.

Do not hard-code today's vendor or Suwappu pricing into product logic. Load prices from the current pricing source/config so the economics worksheet can change without rewriting the strategy.

## What to charge for

Good paid boundaries generally map to customer workflow value:

- number/frequency of saved monitors;
- alert delivery and routing;
- longer history and exports;
- shared workspaces / approval roles;
- policy templates and audit logs;
- automation frequency or number of managed workflows;
- reporting/analytics.

Avoid charging based on a promise that a strategy will produce profit. You can sell better tooling, speed, control, and observability without claiming an uncertain market outcome.

## Authority and security checklist

Before live automation:

- use a dedicated agent/wallet for the product/workflow;
- cap trade size and allowed assets/chains;
- make live mode an explicit opt-in;
- simulate before execute;
- persist the idempotency key before the request leaves your process;
- expose a kill switch / disable path;
- use approvals for actions beyond normal policy;
- reconcile through status/webhooks before accounting;
- make state corruption a stop condition, not a reason to silently reset a ledger;
- reserve reconciliation capacity independently from normal scanning traffic;
- log intent → approval → submission → outcome;
- never store a user's private key just to make an example easier.

For self-custody products, `POST /v1/agent/swap` prepares an unsigned transaction. Keep user signing visibly separate from managed-wallet execution.

## A practical four-week validation sequence

The sequence matters more than the calendar:

1. **Read-only:** ship one scanner/report and talk to the people who use it twice.
2. **Workflow:** add saved rules, alerts, history, and instrument activation/retention.
3. **Safety:** add quote → simulation → approval and paper forward testing.
4. **Automation:** only after users ask for it, add policy-bounded managed execution and reconciliation.

At each step, keep a simple decision: are people repeatedly getting enough value to justify the next authority/cost layer?

## Copy these files first

- `src/suwappu.ts` — current REST contract isolated from the older published SDK.
- `src/execution.ts` — durable intent, simulation, idempotent submit, reconciliation.
- `src/storage.ts` — fail-closed, atomic local financial-state persistence.
- `tests/execution.test.ts` — regression tests for the money-moving boundary.
- `src/strategies/dca.ts` — simple strategy integration with confirmed-only history.
- `src/strategies/grid.ts` — downstream accounting that waits for finality.
- `docs/OPERATIONS.md` — deployment, telemetry, backups, SLOs, release gates, and incident response.

Then replace Flywheel's example signal logic with the product logic your users actually need.
