# Contributing

Thanks for improving Suwappu Flywheel. This repository is both a standalone strategy-operations tool and reference code around real financial actions, so safety and accounting behavior are part of the public contract.

## Release gate

Use Bun 1.3.14 or newer and the committed lockfile:

```bash
bun install --frozen-lockfile
bun run verify

cp .env.example .env
docker compose config --quiet
docker build --tag suwappu-flywheel:verify .
```

`bun run verify` must keep typecheck, behavioral tests, the standalone build, and the high/critical dependency audit green. Pull requests must also keep the non-root container contract and CodeQL green.

Never put real API keys, wallet data, transaction payloads, production state, or customer strategy data in tests, fixtures, logs, or pull requests.

## Money-path invariants

Treat a change as money-path sensitive when it affects `--execute`, quote/simulation validation, managed execution, `src/execution.ts`, persistent financial state, idempotency, reconciliation, retries, or live accounting.

Preserve these rules:

- paper/read-only operation remains the default; execution is an explicit capability;
- a live action uses a fresh quote and must pass simulation before managed submission;
- one economic intent and its idempotency key are durable before submission can become ambiguous;
- transport failure, timeout, HTTP 408/5xx, or malformed successful submission is outcome-unknown rather than proven failure;
- retrying one economic action reuses its durable key; a known `swap_id` is reconciled instead of resubmitted;
- holdings, P&L, history, rewards, and learning state consume terminal final amounts, not optimistic quote amounts or request acceptance;
- authoritative financial JSON fails closed on corruption and is never deleted to make a live run continue;
- the supported local live boundary remains single-writer; multi-worker products must move intent uniqueness and coordination to transactional storage;
- paper and live scalper state remain separate; and
- client controls supplement server-side managed-wallet policy rather than replacing it.

Do not add a generic retry wrapper around managed submission.

A money-path pull request should explain the economic action, where authority is granted, what is durable before the side effect, which failures are outcome-unknown, how recovery avoids a duplicate, and the regression test that proves the behavior.

## Strategy and product claims

Keep strategy evaluation evidence separate from product economics. A quote, APY snapshot, paper result, or short evaluation window is not proof of profitable alpha.

When evaluation/accounting logic changes, preserve the distinction between entry evidence, later observed outcomes, paper/live results, and builder contribution margin. Update `README.md`, `BUILDING_A_PRODUCT.md`, `docs/OPERATIONS.md`, and `CHANGELOG.md` whenever their stated contract changes.

## Security

Report security-sensitive findings through [SECURITY.md](SECURITY.md), not a public issue.
