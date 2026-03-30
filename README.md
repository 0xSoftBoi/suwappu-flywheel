# suwappu-flywheel

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Bun-1.0+-orange.svg)](https://bun.sh)

Self-sustaining multi-strategy DeFi agent using [Suwappu](https://suwappu.bot). Start with $50 on Base. $0 API cost.

> **Warning**: This executes real DeFi transactions when dry-run is off. Use test wallets first. Not financial advice. Not audited.

## 5 Strategies, 1 Agent

| Strategy | What It Does | Min Capital | Monthly Cost |
|----------|-------------|-------------|-------------|
| **Yield Rotation** | Auto-find best Morpho lending APY on Base | $50 | $0 |
| **Fear-Adjusted DCA** | Buy more ETH when market is fearful | $5/buy | $0 |
| **Arb Scanner** | Alert on cross-chain price gaps | $0 (alert-only) | $0 |
| **Prediction Scout** | Flag mispriced Polymarket contracts | $0 (alert-only) | $0 |
| **Run All** | Execute all strategies in one pass | $50 | $0 |

## Quick Start

```bash
git clone https://github.com/0xSoftBoi/suwappu-flywheel.git
cd suwappu-flywheel
bun install

# Get a free API key
curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" -d '{"name":"my-flywheel"}'

export SUWAPPU_API_KEY=suwappu_sk_...

# Run everything (dry-run by default)
bun run src/cli.ts run
```

## Usage

```bash
# ── Yield: find best lending rates ──
bun run src/cli.ts yield
bun run src/cli.ts yield --top 5 --min-apy 5 --json

# ── DCA: fear-adjusted buying ──
bun run src/cli.ts dca --token ETH --amount 10 --dry-run
bun run src/cli.ts dca --token ETH --amount 5 --fear-adjust --dry-run
bun run src/cli.ts dca --token SOL --amount 5 --no-dry-run  # LIVE

# ── Arb: cross-chain price scanner ──
bun run src/cli.ts arb --tokens ETH,SOL --chains base,arbitrum,optimism
bun run src/cli.ts arb --min-spread 0.5 --json

# ── Predict: Polymarket scout ──
bun run src/cli.ts predict --top 10
bun run src/cli.ts predict --json

# ── Status: portfolio dashboard ──
bun run src/cli.ts status

# ── Run All ──
bun run src/cli.ts run --dry-run    # safe: scan only
bun run src/cli.ts run --no-dry-run # live: executes DCA
bun run src/cli.ts run --json       # pipe to monitoring
```

## Example Output

```
╔══════════════════════════════════════════╗
║       SUWAPPU FLYWHEEL — RUN ALL        ║
╚══════════════════════════════════════════╝
  Mode: DRY RUN (no trades executed)

[14:30:01] [run] Fear & Greed: 10/100 (Extreme Fear)

── YIELD ROTATION ──
[14:30:02] [yield] Scanning Morpho markets on chain 8453...

  Market                     Supply APY   Utilization   TVL
  ──────────────────────────────────────────────────────────────
  USDC/cbBTC                 12.50%       95.0%         $2.50M
  USDC/WETH                  8.20%        88.5%         $5.10M
  USDC/wstETH                5.20%        80.0%         $1.00M

[14:30:02] [yield] Best: USDC/cbBTC at 12.50% APY
[14:30:02] [yield] $100 deposited here earns ~$12.50/year

── DCA ──
[14:30:03] [dca] Fear multiplier: 4x → buying 20 USDC of ETH
[14:30:03] [dca] ETH: $1,995.88
[14:30:04] [dca] DRY RUN: Would buy 20 USDC → 0.01002 ETH on base
[14:30:04] [dca]   Rate: 1 ETH = $1,995.88 | Via: Li.Fi

── ARB SCANNER ──
[14:30:05] [arb] Scanning ETH across base,arbitrum,optimism...
  ETH prices:
    base         $1,995.88
    arbitrum     $1,996.12
    optimism     $1,995.50
[14:30:06] [arb] No spreads above 0.1% found

── PREDICTION SCOUT ──
[14:30:07] [predict] Scanning 5 prediction markets...

  Will Bitcoin hit $100k by end of 2026?
    YES: 72% | Vol: $4.2M | Ends: 2026-12-31 | Sum: 100.0%

  Will the Fed cut rates in Q2 2026?
    YES: 54% | Vol: $890K | Ends: 2026-06-30 | Sum: 100.0%

[14:30:07] [predict] No obvious mispricing detected

── SUMMARY ──
[14:30:07] [run] All strategies scanned. Review above for opportunities.
[14:30:07] [run] Remove --dry-run to enable DCA execution.
```

## How It Makes Money

1. **Yield rotation** (passive) — ARMA-style lending optimization earns 8-15% APY on stablecoins by rotating between Morpho, Moonwell, and Aave based on real-time APR differentials. Even $50 benefits because Base gas is <$0.01/tx.

2. **Fear-adjusted DCA** (semi-passive) — backtested to 1,145% over 7 years. Buys 4x more during Extreme Fear (currently at 10/100 — historically the best time). At $5/day base, that's $20/day during fear.

3. **Arb alerts** (information) — scans cross-chain price gaps. Won't auto-execute (bridge risk), but alerts you to manual opportunities.

4. **Prediction scout** (information) — finds mispriced Polymarket contracts where YES+NO ≠ 100%.

## The Math

| Capital | Yield (10% APY) | DCA Gains (historical) | Total | Covers Costs? |
|---------|-----------------|----------------------|-------|---------------|
| $50 | $5/yr | Unrealized | $5/yr | Yes ($0 cost) |
| $100 | $10/yr | Unrealized | $10/yr | Yes |
| $500 | $50/yr | Unrealized | $50/yr | Yes, profitably |
| $1,000 | $100/yr | Unrealized | $100/yr | Self-sustaining |

**Start small, prove it works, then scale.**

## Docker

```bash
cp .env.example .env  # edit with your API key
docker compose up -d
docker compose logs -f
```

## Development

```bash
bun install
bun test        # 20+ tests
bun run check   # typecheck
bun run start   # dry-run all strategies
```

## Links

- [Suwappu API](https://docs.suwappu.bot) | [SDK](https://npmjs.com/package/@suwappu/sdk)
- [Research: Profitable Agent Strategies](https://github.com/0xSoftBoi/suwappu-flywheel/wiki)

## License

MIT
