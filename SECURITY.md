# Security Policy

This repository is a standalone strategy-operations application built on the
[Suwappu API](https://github.com/0xSoftBoi/suwappubot). DCA, grid, and scalper
workflows can initiate real managed-wallet transactions when `--execute` is
enabled. Treat API keys, wallet policy, execution state, backups, and customer
strategy data as sensitive.

## Reporting a vulnerability

**Do not open a public issue for security reports.** Instead:

- Use **GitHub Private Vulnerability Reporting** when it is enabled for this repository, or
- Email **security@suwappu.bot**.

Please include the affected file, version or commit, reproduction steps, and an
impact assessment.

**Scope note:** issues in this repository's own code, SDK usage, dependencies,
or CI belong here. Vulnerabilities in the Suwappu API, core bot, smart
contracts, custody/key-management layer, or shared SDK should be reported
upstream through the
[core security policy](https://github.com/0xSoftBoi/suwappubot/security/policy).

## Custody and execution model

Flywheel's live paths use the Suwappu-managed wallet attached to the agent API
key. Strategy code must not receive a private signing key. Self-custody is a
separate flow: prepare an unsigned transaction and let the user's wallet review
and sign it.

Every managed action must keep the following boundary:

1. obtain a fresh quote;
2. simulate it;
3. persist one economic intent and idempotency key;
4. submit once;
5. reconcile status; and
6. account only terminal-success final amounts.

Timeout/network failure, HTTP 408/5xx, or a malformed successful submission
can mean the outcome is unknown. Preserve the intent/key and reconcile before
creating any replacement action.

## Durable-state boundary

The execution journal and live strategy files are financial operational state.
Existing corrupt JSON fails closed and authoritative writes use atomic
replacement. Never respond to a state error by deleting the file and rerunning
live automation.

The local store supports one live writer per state directory/volume. Managed
submission uses an exclusive local `execution.lock`; a stale lock after an
abnormal exit is a stop condition until the journal is reconciled. For
multi-worker services, move the state machine to a transactional database with
unique intent constraints and locking/leases.

Compose persists `/data` in the `flywheel_state` named volume so disposable
containers do not discard idempotency/reconciliation state. Back up that volume
before live upgrades and keep state backups protected from unauthorized access.

## Logging and dependencies

`SUWAPPU_API_EVENTS=1` emits only operation/outcome/duration/status metadata.
Do not add API keys, wallet addresses, quote/swap IDs, request/response bodies,
strategy inputs, or raw error bodies to this event stream.

CI blocks high/critical advisories reported by `bun audit`, builds the container
contract, and runs CodeQL. Dependabot remains enabled for npm and GitHub Actions.
Re-evaluate advisories rather than adding broad permanent ignores.

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the deployment contract,
release gates, retry matrix, backups, and live-money incident runbook.

## Our commitment

- **Acknowledge** reports within 3 business days.
- **Triage and severity** within 7 business days.
- **Coordinate disclosure** with the reporter and provide credit unless
  anonymity is requested.

## Safe harbor

Good-faith research conducted under this policy, without privacy violations,
data destruction, or service degradation, will not result in legal action from
us. If in doubt, contact us before testing.
