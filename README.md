# Suwappu Flywheel

A reference multi-strategy DeFi agent built on [Suwappu](https://suwappu.bot). It shows how to compose quotes, market data, lending and prediction APIs with stateful strategies while keeping live execution behind an explicit boundary.

> **Safety:** commands are scan/dry-run by default. Live DCA, grid, and scalper actions require `--execute` and use Suwappu's managed-wallet execution pipeline. Start with a test wallet and conservative wallet policies. This repository is an example, not financial advice, and is not audited.

## What this example teaches

| Pattern | Where to look | Default |
|---|---|---|
| Swap quotes with the published TypeScript SDK | `src/strategies/dca.ts`, `src/strategies/arb.ts` | Read-only quote |
| Lending and prediction namespaces | `src/strategies/yield.ts`, `src/strategies/predict.ts` | Read-only |
| Managed-wallet swap submission | `src/suwappu.ts` | Only with `--execute` |
| Stateful DCA + take-profit logic | `src/strategies/dca.ts`, `src/strategies/grid.ts` | Dry-run/check |
| Risk guards and strategy state | `src/portfolio.ts`, `src/brain/`, `src/scalper.ts` | Local state |

### SDK version note

This repo targets the currently published `@suwappu/sdk@0.4.x`. The `suwappubot` monorepo already contains newer 0.6.x source APIs such as managed `swap()`, `simulateSwap()`, self-custody `prepareSwap()`, wallet lifecycle, policies, approvals, audit, and kill-switch helpers, but that version is not yet published to npm.

Until the matching package release lands, Flywheel keeps quote construction on the published SDK and isolates the current managed execution REST contract in `src/suwappu.ts`. That makes the version boundary visible instead of teaching code that cannot be installed from npm today.

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

# Safe default: scan/quote, do not trade.
bun run src/cli.ts run
```

You do not need a private key in this project.

## Commands

| Command | Purpose | Live action |
|---|---|---|
| `yield` | Scan lending markets | None |
| `dca` | Quote a DCA buy | `--execute` |
| `arb` | Scan cross-chain price gaps | None |
| `predict` | Browse prediction-market signals | None |
| `grid` | Check take-profit levels | `--execute` |
| `status` | API/wallet status | None |
| `watch` | Repeat market scans | None |
| `portfolio` | Local risk/strategy report | None |
| `run` | Run the DCA + grid flywheel | `--execute` |
| `scalp` | Run the mean-reversion example | `--execute` |

Examples:

```bash
# DCA — dry-run unless --execute is present
bun run src/cli.ts dca --token ETH --amount 10
bun run src/cli.ts dca --token ETH --amount 5 --fear-adjust
bun run src/cli.ts dca --token ETH --amount 5 --execute

# Read-only scanners
bun run src/cli.ts yield --top 5 --min-apy 5
bun run src/cli.ts arb --tokens ETH,SOL --chains base,arbitrum,optimism
bun run src/cli.ts predict --top 10
bun run src/cli.ts watch --interval 300

# Grid + full flywheel
bun run src/cli.ts grid
bun run src/cli.ts grid --execute
bun run src/cli.ts run
bun run src/cli.ts run --execute

# Portfolio + scalper
bun run src/cli.ts portfolio
bun run src/cli.ts scalp --amount 2
bun run src/cli.ts scalp --amount 2 --execute
```

Use `--json` on commands that expose it when another agent or monitor will consume the output.

## Managed vs self-custody execution

Flywheel's live paths use Suwappu-managed wallets:

```bash
# Provision (or return) the managed wallet associated with this agent.
curl -X POST https://api.suwappu.bot/v1/agent/wallets \
  -H "Authorization: Bearer $SUWAPPU_API_KEY"
```

Configure appropriate wallet policies before funding or enabling live strategies. Once a quote is accepted, Flywheel submits its quote id to `POST /v1/agent/swap/execute` and records the returned `swap_id` so a missing/late transaction hash is not mistaken for permission to submit the same strategy action again.

For self-custody, use `POST /v1/agent/swap` to prepare an **unsigned** transaction and sign it in your own wallet. In the 0.6.x SDK source this is exposed as `prepareSwap()`. Flywheel intentionally does not embed local signing code.

## Safety boundaries

- No command trades merely because an API key is present; live strategy paths require `--execute`.
- `WALLET_ADDRESS` is for portfolio/balance monitoring. It is not a private key and is not used as the managed execution wallet.
- DCA CLI orders are capped by `SUWAPPU_MAX_TRADE_USD` (default `1000`) unless you explicitly change it.
- The scalper also has hourly-trade, daily-loss, cooldown, and stop guards in code. Treat those as example controls, not guarantees.
- Keep API keys out of git. Use separate agents/wallets and conservative limits while developing.

## Development

```bash
bun install --frozen-lockfile
bun run check
bun test
```

CI runs the same typecheck and tests without `|| true`, so a broken SDK contract fails the PR instead of being silently ignored.

## Links

- [Suwappu](https://suwappu.bot)
- [Suwappu docs](https://docs.suwappu.bot)
- [Published TypeScript SDK](https://www.npmjs.com/package/@suwappu/sdk)
- [Suwappu SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)

## License

MIT
