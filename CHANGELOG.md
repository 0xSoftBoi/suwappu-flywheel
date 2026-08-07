# Changelog

## 2.0.0 — 2026-08-07

### Enterprise operating contract

- make authoritative JSON state fail closed on corruption and persist via fsync + atomic rename;
- add a fail-closed local managed-execution writer lock so overlapping live processes cannot submit concurrently;
- preserve `/data` across disposable Compose containers and run the image as non-root;
- add bounded managed REST operations and opt-in metadata-only API events;
- classify managed HTTP 408, transport, 5xx, and malformed-success submissions as outcome-unknown;
- add an operator runbook, dependency audit, build/CLI/container release gates, and CodeQL.

### Evaluation correctness

- continue DCA reward maturation through 15m, 1h, and 24h observations instead of freezing after the first score;
- calculate Kelly/strategy attribution from later observed outcomes rather than entry-price quote discrepancy;
- stop inserting a synthetic DCA return at fill time and rebuild the rolling evaluation window from observed outcomes;
- track worst observed portfolio drawdown separately from current drawdown and report the current drawdown age honestly;
- correct the one-observation parametric VaR loss calculation;
- remove the scalper's hard-coded approximate balance; percentage sizing now requires `SUWAPPU_SCALPER_USDC_BUDGET`.

### Breaking data/report changes

- Flywheel state migrates in memory from version 1 to version 2 on load and is written as v2 on the next save;
- portfolio reports rename `maxDrawdown` to `maxObservedDrawdown`, `maxDrawdownDuration` to `currentDrawdownDurationDays`, and strategy attribution `totalPnL` to `cumulativeReturn` because the prior names overstated what those values represented.
