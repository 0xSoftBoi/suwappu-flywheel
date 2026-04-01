#!/usr/bin/env bun
/**
 * Mean-reversion micro-scalp bot with ML training data collection.
 * Polls Binance every N seconds, computes fast indicators, trades on Base.
 * Every tick is logged as a training sample for the Karpathy autoresearch loop.
 */
import { createClient } from "@suwappu/sdk";
import { requireEnv, log } from "./utils.js";
import { calcRSI, calcATRPct } from "./indicators.js";
import { getFearIndex } from "./strategies/dca.js";
import { calculateKelly } from "./portfolio.js";
import { loadState } from "./brain/state.js";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Constants ──
const STATE_DIR = join(homedir(), ".suwappu-flywheel");
const TRAINING_FILE = join(STATE_DIR, "training-data.jsonl");
const SCALPER_STATE_FILE = join(STATE_DIR, "scalper-state.json");
const BINANCE_KLINES = "https://data-api.binance.vision/api/v3/klines";
const BINANCE_TICKER = "https://data-api.binance.vision/api/v3/ticker/price";

const MAX_TRADES_PER_HOUR = 6;
const MAX_DAILY_LOSS_USD = 5;
const COOLDOWN_AFTER_LOSS_MS = 5 * 60 * 1000;
const TRAILING_STOP_PCT = 0.01;
const TRAILING_ACTIVATE_PCT = 0.003; // activate trailing after +0.3%
const HARD_STOP_PCT = 0.01;

// ── Signal thresholds (autoresearch modifies these) ──
export const PARAMS = {
  rsi_buy: 25,
  rsi_sell: 75,
  bb_period: 20,
  bb_std: 2,
  ema_fast: 9,
  ema_slow: 21,
  trend_rsi_max: 70, // don't buy if 1h RSI above this
};

// ── Types ──
interface DetailedCandle {
  openTime: number;
  open: number; high: number; low: number; close: number;
  volume: number;
  quoteVolume: number;
}

interface Signals {
  price: number;
  rsi_7_1m: number;
  rsi_14_5m: number;
  rsi_14_1h: number;
  ema9: number;
  ema21: number;
  ema_cross: "golden" | "death" | "none";
  bb_upper: number;
  bb_lower: number;
  bb_pct: number;
  atr_1m: number;
  vol_ratio: number;
  fear: number;
  vwap: number;
  vwap_dev: number;
}

interface TrainingSample {
  ts: string;
  price: number;
  rsi_7_1m: number;
  rsi_14_5m: number;
  rsi_14_1h: number;
  ema9: number;
  ema21: number;
  ema_cross: string;
  bb_upper: number;
  bb_lower: number;
  bb_pct: number;
  atr_1m: number;
  vol_ratio: number;
  fear: number;
  vwap: number;
  vwap_dev: number;
  pos_open: boolean;
  pos_pnl: number;
  pos_age_s: number;
  action: "buy" | "sell" | "hold";
  reward_5m: number | null;
}

interface ScalperPosition {
  entryPrice: number;
  entryTime: string;
  amount: number;
  ethAmount: number;
  highWatermark: number;
  txHash?: string;
}

interface ClosedTrade {
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  entryTime: string;
  exitTime: string;
  txHash?: string;
}

interface ScalperState {
  position: ScalperPosition | null;
  tradesThisHour: number;
  hourStart: string;
  dailyPnL: number;
  dayStart: string;
  lastLossTime: string | null;
  totalTrades: number;
  totalPnL: number;
  wins: number;
  closedTrades: ClosedTrade[];
}

// ── State persistence ──
function defaultScalperState(): ScalperState {
  return {
    position: null,
    tradesThisHour: 0,
    hourStart: new Date().toISOString(),
    dailyPnL: 0,
    dayStart: new Date().toISOString().slice(0, 10),
    lastLossTime: null,
    totalTrades: 0,
    totalPnL: 0,
    wins: 0,
    closedTrades: [],
  };
}

function loadScalperState(): ScalperState {
  try {
    if (existsSync(SCALPER_STATE_FILE)) {
      const s = JSON.parse(readFileSync(SCALPER_STATE_FILE, "utf-8")) as ScalperState;
      // Reset hourly counter
      const now = new Date();
      if (new Date(s.hourStart).getHours() !== now.getHours()) {
        s.tradesThisHour = 0;
        s.hourStart = now.toISOString();
      }
      // Reset daily counter
      const today = now.toISOString().slice(0, 10);
      if (s.dayStart !== today) {
        s.dailyPnL = 0;
        s.dayStart = today;
      }
      return s;
    }
  } catch {}
  return defaultScalperState();
}

function saveScalperState(s: ScalperState) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SCALPER_STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Binance data ──
async function getDetailedCandles(symbol: string, interval: string, limit: number): Promise<DetailedCandle[]> {
  const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json() as any;
  if (!Array.isArray(data)) throw new Error(`Binance returned: ${JSON.stringify(data).slice(0, 100)}`);
  return data.map((c: any) => ({
    openTime: Number(c[0]),
    open: parseFloat(String(c[1])),
    high: parseFloat(String(c[2])),
    low: parseFloat(String(c[3])),
    close: parseFloat(String(c[4])),
    volume: parseFloat(String(c[5])),
    quoteVolume: parseFloat(String(c[7])),
  }));
}

async function getCurrentPrice(): Promise<number> {
  const res = await fetch(`${BINANCE_TICKER}?symbol=ETHUSDC`);
  const data = await res.json() as { price: string };
  return parseFloat(data.price);
}

// ── Indicator math ──
function calcEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * mult + ema;
  }
  return ema;
}

function calcBollingerBands(closes: number[], period = 20, stdMult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, pctB: 0.5 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + stdMult * sd;
  const lower = mean - stdMult * sd;
  const price = closes[closes.length - 1];
  const range = upper - lower;
  const pctB = range > 0 ? (price - lower) / range : 0.5;
  return { upper, middle: mean, lower, pctB };
}

function calcVWAP(candles: DetailedCandle[]): number {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : candles[candles.length - 1]?.close ?? 0;
}

function calcVolumeRatio(candles: DetailedCandle[], period = 20): number {
  if (candles.length < 2) return 1;
  const vols = candles.map((c) => c.volume);
  const current = vols[vols.length - 1];
  const avg = vols.slice(-period - 1, -1).reduce((s, v) => s + v, 0) / Math.min(period, vols.length - 1);
  return avg > 0 ? current / avg : 1;
}

// ── Signal computation ──
function computeSignals(
  candles1m: DetailedCandle[],
  candles5m: DetailedCandle[],
  candles1h: DetailedCandle[],
  price: number,
  fearValue: number
): Signals {
  const closes1m = candles1m.map((c) => c.close);
  const closes5m = candles5m.map((c) => c.close);
  const closes1h = candles1h.map((c) => c.close);

  const rsi_7_1m = calcRSI(candles1m.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close })), 7);
  const rsi_14_5m = calcRSI(candles5m.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close })), 14);
  const rsi_14_1h = calcRSI(candles1h.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close })), 14);

  const ema9 = calcEMA(closes1m, PARAMS.ema_fast);
  const ema21 = calcEMA(closes1m, PARAMS.ema_slow);
  const prevEma9 = calcEMA(closes1m.slice(0, -1), PARAMS.ema_fast);
  const prevEma21 = calcEMA(closes1m.slice(0, -1), PARAMS.ema_slow);
  let ema_cross: "golden" | "death" | "none" = "none";
  if (prevEma9 <= prevEma21 && ema9 > ema21) ema_cross = "golden";
  else if (prevEma9 >= prevEma21 && ema9 < ema21) ema_cross = "death";

  const bb = calcBollingerBands(closes1m, PARAMS.bb_period, PARAMS.bb_std);
  const atr_1m = calcATRPct(candles1m.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close })), 7);
  const vol_ratio = calcVolumeRatio(candles1m);
  const vwap = calcVWAP(candles1m);
  const vwap_dev = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;

  return {
    price, rsi_7_1m, rsi_14_5m, rsi_14_1h,
    ema9, ema21, ema_cross,
    bb_upper: bb.upper, bb_lower: bb.lower, bb_pct: bb.pctB,
    atr_1m, vol_ratio, fear: fearValue,
    vwap, vwap_dev,
  };
}

// ── Decision engine ──
export function decideAction(
  signals: Signals,
  position: ScalperPosition | null,
  state: ScalperState
): "buy" | "sell" | "hold" {
  const now = Date.now();

  // Safety guards
  if (state.dailyPnL <= -MAX_DAILY_LOSS_USD) return "hold";
  if (state.tradesThisHour >= MAX_TRADES_PER_HOUR) return "hold";
  if (state.lastLossTime && (now - new Date(state.lastLossTime).getTime()) < COOLDOWN_AFTER_LOSS_MS) return "hold";

  // SELL checks (if position open)
  if (position) {
    const pnlPct = (signals.price - position.entryPrice) / position.entryPrice;

    // Hard stop loss
    if (pnlPct <= -HARD_STOP_PCT) return "sell";

    // Trailing stop (activates after +0.3%)
    if (pnlPct > TRAILING_ACTIVATE_PCT) {
      const dropFromHigh = (position.highWatermark - signals.price) / position.highWatermark;
      if (dropFromHigh >= TRAILING_STOP_PCT) return "sell";
    }

    // Mean reversion target
    if (signals.price > signals.bb_upper && signals.rsi_7_1m > PARAMS.rsi_sell && pnlPct > 0) {
      return "sell";
    }

    return "hold";
  }

  // BUY checks (no position)
  // Trend filter: don't buy dips in sustained uptrend overbought
  if (signals.rsi_14_1h > PARAMS.trend_rsi_max) return "hold";

  if (
    signals.price < signals.bb_lower &&
    signals.rsi_7_1m < PARAMS.rsi_buy &&
    signals.price < signals.vwap
  ) {
    return "buy";
  }

  return "hold";
}

// ── Execution ──
async function executeBuy(apiKey: string, amount: number, dryRun: boolean) {
  const client = createClient({ apiKey });
  const quote = await client.getQuote("USDC", "ETH", amount, "base");

  if (dryRun) {
    return { success: true, ethAmount: parseFloat(quote.toAmount), price: amount / parseFloat(quote.toAmount), txHash: "dry-run" };
  }

  const res = await fetch("https://api.suwappu.bot/v1/agent/swap/sign-and-send", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ quote_id: quote.id }),
  });
  const swap = await res.json() as { tx_hash?: string; success?: boolean; error?: string };
  if (!swap.success) throw new Error(swap.error || "Buy failed");
  return { success: true, ethAmount: parseFloat(quote.toAmount), price: amount / parseFloat(quote.toAmount), txHash: swap.tx_hash };
}

async function executeSell(apiKey: string, ethAmount: number, dryRun: boolean) {
  if (dryRun) {
    return { success: true, usdcReceived: ethAmount * 2100, price: 2100, txHash: "dry-run" };
  }

  const quoteRes = await fetch("https://api.suwappu.bot/v1/agent/quote", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from_token: "ETH", to_token: "USDC", amount: ethAmount.toFixed(6), chain: "base" }),
  });
  const quote = await quoteRes.json() as { id: string; toAmount: string };

  const res = await fetch("https://api.suwappu.bot/v1/agent/swap/sign-and-send", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ quote_id: quote.id }),
  });
  const swap = await res.json() as { tx_hash?: string; success?: boolean; error?: string };
  if (!swap.success) throw new Error(swap.error || "Sell failed");
  return { success: true, usdcReceived: parseFloat(quote.toAmount), price: parseFloat(quote.toAmount) / ethAmount, txHash: swap.tx_hash };
}

// ── Training data ──
function appendSample(sample: TrainingSample) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(TRAINING_FILE, JSON.stringify(sample) + "\n");
}

function backfillTradeReward(entryTime: string, exitTime: string, pnlPct: number) {
  if (!existsSync(TRAINING_FILE)) return;
  try {
    const lines = readFileSync(TRAINING_FILE, "utf-8").split("\n").filter(Boolean);
    const entryMs = new Date(entryTime).getTime();
    const exitMs = new Date(exitTime).getTime();
    let modified = false;

    const updated = lines.map((line) => {
      try {
        const sample = JSON.parse(line) as TrainingSample;
        const ts = new Date(sample.ts).getTime();
        if (ts >= entryMs && ts <= exitMs && sample.reward_5m === null) {
          sample.reward_5m = pnlPct;
          modified = true;
          return JSON.stringify(sample);
        }
      } catch {}
      return line;
    });

    if (modified) {
      writeFileSync(TRAINING_FILE, updated.join("\n") + "\n");
    }
  } catch {}
}

// ── TUI display ──
const CSI = "\x1b[";
const c = {
  reset: `${CSI}0m`, bold: `${CSI}1m`, dim: `${CSI}2m`,
  green: `${CSI}38;5;114m`, red: `${CSI}38;5;203m`, yellow: `${CSI}38;5;214m`,
  blue: `${CSI}38;5;75m`, muted: `${CSI}38;5;242m`, white: `${CSI}1;37m`,
  border: `${CSI}38;5;240m`,
};

function renderTick(signals: Signals, position: ScalperPosition | null, state: ScalperState, action: string, tickNum: number, dryRun: boolean) {
  const { price, rsi_7_1m, bb_pct, vwap, ema9, ema21, atr_1m, vol_ratio, fear } = signals;
  const mode = dryRun ? `${c.yellow}DRY RUN${c.reset}` : `${c.red}LIVE${c.reset}`;

  let posLine: string;
  if (position) {
    const pnlPct = ((price - position.entryPrice) / position.entryPrice * 100);
    const pnlColor = pnlPct >= 0 ? c.green : c.red;
    const age = Math.floor((Date.now() - new Date(position.entryTime).getTime()) / 1000);
    const ageStr = age < 60 ? `${age}s` : `${Math.floor(age / 60)}m${age % 60}s`;
    posLine = `${c.green}LONG${c.reset} $${position.amount} @ $${position.entryPrice.toFixed(2)} (${pnlColor}${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%${c.reset}) age:${ageStr}`;
  } else {
    posLine = `${c.muted}No position${c.reset}`;
  }

  const winRate = state.totalTrades > 0 ? `${state.wins}/${state.totalTrades}` : "0/0";
  const pnlColor = state.dailyPnL >= 0 ? c.green : c.red;
  const actionColor = action === "buy" ? c.green : action === "sell" ? c.red : c.muted;

  const rsiColor = rsi_7_1m < 30 ? c.green : rsi_7_1m > 70 ? c.red : c.yellow;
  const bbColor = bb_pct < 0.2 ? c.green : bb_pct > 0.8 ? c.red : c.yellow;

  const lines = [
    `${c.border}\u256d\u2500 SCALPER ${mode} ${"─".repeat(44)}${c.border}\u256e${c.reset}`,
    `${c.border}\u2502${c.reset} ETH ${c.white}$${price.toFixed(2)}${c.reset}  ${rsiColor}RSI(7):${rsi_7_1m.toFixed(0)}${c.reset}  ${bbColor}BB%:${bb_pct.toFixed(2)}${c.reset}  VWAP:$${vwap.toFixed(0)}  Fear:${fear}`,
    `${c.border}\u2502${c.reset} EMA9:$${ema9.toFixed(0)} ${ema9 > ema21 ? c.green + ">" : c.red + "<"}${c.reset} EMA21:$${ema21.toFixed(0)}  ATR:${atr_1m.toFixed(2)}%  Vol:${vol_ratio.toFixed(1)}x`,
    `${c.border}\u2502${c.reset} ${posLine}`,
    `${c.border}\u2502${c.reset} Today: ${state.tradesThisHour}/6h  P&L: ${pnlColor}${state.dailyPnL >= 0 ? "+" : ""}$${state.dailyPnL.toFixed(2)}${c.reset}  Win: ${winRate}  Total: ${c.white}$${state.totalPnL.toFixed(2)}${c.reset}`,
    `${c.border}\u2502${c.reset} ${actionColor}${c.bold}${action.toUpperCase()}${c.reset} ${c.muted}tick #${tickNum}${c.reset}`,
    `${c.border}\u2570${"─".repeat(56)}\u256f${c.reset}`,
  ];

  process.stdout.write(`${CSI}2J${CSI}H` + lines.join("\n") + "\n");
}

// ── Main loop ──
export async function runScalper(opts: {
  execute: boolean;
  amount: number;
  interval: number;
  dryRun: boolean;
}) {
  const apiKey = requireEnv("SUWAPPU_API_KEY");
  const state = loadScalperState();
  let tickNum = 0;
  let cachedFear = 8;
  let lastFearFetch = 0;

  log("scalper", `Starting — ${opts.dryRun ? "DRY RUN" : "LIVE"} | $${opts.amount}/trade | ${opts.interval}s interval`);

  const shutdown = () => {
    saveScalperState(state);
    log("scalper", `Stopped. ${state.totalTrades} trades, P&L: $${state.totalPnL.toFixed(2)}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Kelly sizing
  const brainState = loadState();
  const kelly = calculateKelly(brainState.trades);
  const maxFraction = kelly.sufficient && kelly.halfKelly > 0 ? kelly.halfKelly : 0.05;

  while (true) {
    tickNum++;
    try {
      // Fetch data in parallel
      const [candles1m, candles5m, candles1h, price] = await Promise.all([
        getDetailedCandles("ETHUSDC", "1m", 50),
        getDetailedCandles("ETHUSDC", "5m", 30),
        getDetailedCandles("ETHUSDC", "1h", 24),
        getCurrentPrice(),
      ]);

      // Fear index (cache 5 min)
      if (Date.now() - lastFearFetch > 5 * 60 * 1000) {
        try {
          const fear = await getFearIndex();
          cachedFear = fear.value;
          lastFearFetch = Date.now();
        } catch {}
      }

      // Compute signals
      const signals = computeSignals(candles1m, candles5m, candles1h, price, cachedFear);

      // Update position high watermark
      if (state.position && price > state.position.highWatermark) {
        state.position.highWatermark = price;
      }

      // Decide
      const action = decideAction(signals, state.position, state);

      // Execute
      if (action === "buy" && !state.position) {
        const tradeAmount = Math.min(opts.amount, Math.max(1, Math.floor(32 * maxFraction))); // 32 = approximate USDC balance
        try {
          const result = await executeBuy(apiKey, tradeAmount, opts.dryRun);
          state.position = {
            entryPrice: result.price,
            entryTime: new Date().toISOString(),
            amount: tradeAmount,
            ethAmount: result.ethAmount,
            highWatermark: price,
            txHash: result.txHash,
          };
          state.tradesThisHour++;
          log("scalper", `BUY $${tradeAmount} → ${result.ethAmount.toFixed(6)} ETH @ $${result.price.toFixed(2)}`);
        } catch (e: any) {
          log("scalper", `Buy failed: ${e.message}`);
        }
      } else if (action === "sell" && state.position) {
        try {
          const result = await executeSell(apiKey, state.position.ethAmount, opts.dryRun);
          const pnl = (opts.dryRun ? state.position.ethAmount * price : result.usdcReceived) - state.position.amount;
          const pnlPct = pnl / state.position.amount;

          state.dailyPnL += pnl;
          state.totalPnL += pnl;
          state.totalTrades++;
          if (pnl > 0) state.wins++;
          if (pnl < 0) state.lastLossTime = new Date().toISOString();

          state.closedTrades.push({
            entryPrice: state.position.entryPrice,
            exitPrice: result.price,
            pnl,
            pnlPct,
            entryTime: state.position.entryTime,
            exitTime: new Date().toISOString(),
            txHash: result.txHash,
          });

          // Keep last 100 trades
          if (state.closedTrades.length > 100) state.closedTrades = state.closedTrades.slice(-100);

          // Backfill training data
          backfillTradeReward(state.position.entryTime, new Date().toISOString(), pnlPct);

          log("scalper", `SELL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(3)} (${(pnlPct * 100).toFixed(2)}%) @ $${result.price.toFixed(2)}`);
          state.position = null;
        } catch (e: any) {
          log("scalper", `Sell failed: ${e.message}`);
        }
      }

      // Append training sample
      const sample: TrainingSample = {
        ts: new Date().toISOString(),
        price: signals.price,
        rsi_7_1m: Math.round(signals.rsi_7_1m * 10) / 10,
        rsi_14_5m: Math.round(signals.rsi_14_5m * 10) / 10,
        rsi_14_1h: Math.round(signals.rsi_14_1h * 10) / 10,
        ema9: Math.round(signals.ema9 * 100) / 100,
        ema21: Math.round(signals.ema21 * 100) / 100,
        ema_cross: signals.ema_cross,
        bb_upper: Math.round(signals.bb_upper * 100) / 100,
        bb_lower: Math.round(signals.bb_lower * 100) / 100,
        bb_pct: Math.round(signals.bb_pct * 1000) / 1000,
        atr_1m: Math.round(signals.atr_1m * 100) / 100,
        vol_ratio: Math.round(signals.vol_ratio * 100) / 100,
        fear: signals.fear,
        vwap: Math.round(signals.vwap * 100) / 100,
        vwap_dev: Math.round(signals.vwap_dev * 1000) / 1000,
        pos_open: !!state.position,
        pos_pnl: state.position ? (signals.price - state.position.entryPrice) / state.position.entryPrice : 0,
        pos_age_s: state.position ? Math.floor((Date.now() - new Date(state.position.entryTime).getTime()) / 1000) : 0,
        action,
        reward_5m: null,
      };
      appendSample(sample);

      // Render
      renderTick(signals, state.position, state, action, tickNum, opts.dryRun);

      // Save state every 10 ticks
      if (tickNum % 10 === 0) saveScalperState(state);

    } catch (e: any) {
      log("scalper", `Tick error: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, opts.interval * 1000));
  }
}

// Direct execution
if (import.meta.main) {
  const execute = process.argv.includes("--execute");
  const amountIdx = process.argv.indexOf("--amount");
  const amount = amountIdx >= 0 ? parseFloat(process.argv[amountIdx + 1]) : 2;
  const intervalIdx = process.argv.indexOf("--interval");
  const interval = intervalIdx >= 0 ? parseInt(process.argv[intervalIdx + 1]) : 10;

  runScalper({ execute, amount, interval, dryRun: !execute }).catch(console.error);
}
