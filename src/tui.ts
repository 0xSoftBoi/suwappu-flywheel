#!/usr/bin/env bun

// Auto-load .env from project root
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "..", ".env");
try {
  const envFile = await Bun.file(envPath).text();
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

import { createClient } from "@suwappu/sdk";
import { requireEnv, log } from "./utils.js";
import { getFearIndex, fearMultiplier, executeDCA, getUSDCBalance, getETHBalance, getDCAHistory } from "./strategies/dca.js";
import { scanArb, executeArb } from "./strategies/arb.js";
import type { ArbOpportunity } from "./strategies/arb.js";
import { scanYield } from "./strategies/yield.js";
import { scanPredictions } from "./strategies/predict.js";
import { checkGrid } from "./strategies/grid.js";
import { loadState, saveState, syncFromDCAHistory, updatePortfolio } from "./brain/state.js";
import { getCandles, calcRSI, calcATRPct, rsiMultiplier } from "./indicators.js";
import { adaptParameters } from "./brain/adapt.js";
import { backfillRewards } from "./brain/reward.js";

// ── ANSI helpers ──
const ESC = "\x1b";
const CSI = `${ESC}[`;
const c = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  black: `${CSI}30m`,
  red: `${CSI}31m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  blue: `${CSI}34m`,
  magenta: `${CSI}35m`,
  cyan: `${CSI}36m`,
  white: `${CSI}37m`,
  brightBlack: `${CSI}90m`,
  brightRed: `${CSI}91m`,
  brightGreen: `${CSI}92m`,
  brightYellow: `${CSI}93m`,
  brightCyan: `${CSI}96m`,
  brightWhite: `${CSI}97m`,
  bgBlue: `${CSI}44m`,
  bgCyan: `${CSI}46m`,
  bgBlack: `${CSI}40m`,
};

// ── Semantic theme (256-color) ──
const t = {
  // Chrome
  headerBg: `${CSI}48;5;17m`,
  headerFg: `${CSI}38;5;75m`,
  footerBg: `${CSI}48;5;235m`,
  footerFg: `${CSI}38;5;250m`,
  // Borders
  border: `${CSI}38;5;240m`,
  borderActive: `${CSI}38;5;75m`,
  borderTitle: `${CSI}38;5;75m`,
  // Data
  label: `${CSI}38;5;245m`,
  value: `${CSI}1;37m`,
  accent: `${CSI}38;5;75m`,
  // Semantic
  positive: `${CSI}38;5;114m`,
  negative: `${CSI}38;5;203m`,
  warning: `${CSI}38;5;214m`,
  muted: `${CSI}38;5;242m`,
  // Tabs
  tabActive: `${CSI}1;38;5;75m`,
  tabInactive: `${CSI}38;5;245m`,
  tabUnderline: `${CSI}38;5;75m`,
};

const altScreenOn = `${CSI}?1049h`;
const altScreenOff = `${CSI}?1049l`;
const cursorHide = `${CSI}?25l`;
const cursorShow = `${CSI}?25h`;
const clearScreen = `${CSI}2J${CSI}H`;

function moveTo(row: number, col: number) {
  return `${CSI}${row};${col}H`;
}

// ── Layout ──
interface Layout {
  width: number;
  height: number;
  headerRow: number;
  tabBarRow: number;
  contentStart: number;
  contentEnd: number;
  footerSepRow: number;
  footerRow: number;
  twoCol: boolean;
  halfW: number;
}

function computeLayout(): Layout {
  const cols = Math.max(80, process.stdout.columns || 80);
  const rows = Math.max(24, process.stdout.rows || 24);
  const width = Math.min(cols, 140);
  return {
    width,
    height: rows,
    headerRow: 1,
    tabBarRow: 2,
    contentStart: 4,
    contentEnd: rows - 3,
    footerSepRow: rows - 2,
    footerRow: rows - 1,
    twoCol: width >= 110,
    halfW: Math.floor((Math.min(cols, 140) - 3) / 2),
  };
}

// ── Box drawing ──
function box(x: number, y: number, w: number, h: number, opts?: {
  title?: string;
  subtitle?: string;
  color?: string;
  noBottom?: boolean;
}): string {
  const color = opts?.color ?? t.border;
  let out = "";
  out += `${color}${moveTo(y, x)}\u256d${"\u2500".repeat(w - 2)}\u256e`;
  for (let i = 1; i < h - 1; i++) {
    out += `${moveTo(y + i, x)}\u2502${" ".repeat(w - 2)}\u2502`;
  }
  if (!opts?.noBottom) {
    out += `${moveTo(y + h - 1, x)}\u2570${"\u2500".repeat(w - 2)}\u256f`;
  }
  out += c.reset;
  if (opts?.title) {
    out += `${moveTo(y, x + 2)}${color}${c.bold} ${opts.title} ${c.reset}`;
  }
  if (opts?.subtitle) {
    const subLen = stripAnsi(opts.subtitle).length + 2;
    out += `${moveTo(y, x + w - subLen - 2)}${t.muted} ${opts.subtitle} ${c.reset}`;
  }
  return out;
}

function text(x: number, y: number, str: string): string {
  return `${moveTo(y, x)}${str}${c.reset}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function pad(s: string, len: number): string {
  const stripped = stripAnsi(s);
  return s + " ".repeat(Math.max(0, len - stripped.length));
}

function rpad(s: string, len: number): string {
  const stripped = stripAnsi(s);
  return " ".repeat(Math.max(0, len - stripped.length)) + s;
}

// ── Sparkline ──
const SPARK_CHARS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";

function sparkline(data: number[], width = 12): string {
  if (data.length === 0) return `${t.muted}${"·".repeat(width)}${c.reset}`;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  // Resample if needed
  let sampled = data;
  if (data.length > width) {
    sampled = [];
    for (let i = 0; i < width; i++) {
      const idx = Math.floor((i / width) * data.length);
      sampled.push(data[idx]);
    }
  } else if (data.length < width) {
    sampled = data;
  }
  let out = "";
  for (const val of sampled) {
    const idx = Math.round(((val - min) / range) * (SPARK_CHARS.length - 1));
    out += SPARK_CHARS[idx];
  }
  const trendColor = sampled[sampled.length - 1] >= sampled[0] ? t.positive : t.negative;
  return `${trendColor}${out}${c.reset}`;
}

// ── Format helpers ──
function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number, plus = true): string {
  const sign = n >= 0 && plus ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtPctColor(n: number): string {
  const col = n >= 0 ? t.positive : t.negative;
  return `${col}${fmtPct(n)}${c.reset}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fearBar(value: number): string {
  const total = 20;
  const filled = Math.round((value / 100) * total);
  let barColor: string;
  if (value <= 25) barColor = t.negative;
  else if (value <= 45) barColor = t.warning;
  else if (value <= 55) barColor = c.white;
  else if (value <= 75) barColor = t.positive;
  else barColor = c.brightGreen;
  return `${barColor}${"█".repeat(filled)}${t.muted}${"░".repeat(total - filled)}${c.reset}`;
}

function rsiBar(value: number): string {
  const total = 20;
  const pos = Math.round((value / 100) * total);
  let bar = "";
  for (let i = 0; i < total; i++) {
    if (i === pos) bar += `${c.brightWhite}\u2502${c.reset}`;
    else if (i < 6) bar += `${t.positive}\u2500`;
    else if (i < 14) bar += `${t.warning}\u2500`;
    else bar += `${t.negative}\u2500`;
  }
  return bar + c.reset;
}

// ── Spinner ──
const SPINNER_FRAMES = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f";
let spinnerIdx = 0;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerCol = 0;

function startSpinner() {
  if (spinnerInterval) return;
  spinnerInterval = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
    const frame = SPINNER_FRAMES[spinnerIdx];
    if (spinnerCol > 0) {
      process.stdout.write(moveTo(1, spinnerCol) + `${t.warning}${frame}${c.reset}`);
    }
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
}

// ── State ──
type View = "dashboard" | "arb" | "yield" | "predict" | "trades" | "running" | "confirm-run" | "confirm-arb" | "help";

interface AppState {
  view: View;
  previousView: View;
  loading: boolean;
  lastRefresh: Date | null;
  error: string | null;
  dryRun: boolean;
  // Data
  prices: Record<string, { usd: number; change_24h: number }>;
  priceHistory: Record<string, number[]>;
  fear: { value: number; classification: string };
  rsi: number;
  atrPct: number;
  portfolio: { usdc: number; eth: number; total: number; pnl: number; pnlPct: number; peak: number; drawdown: number };
  brain: { trades: number; dcaMult: number; arbSpread: number; adaptation: string };
  grid: { price: number; entry: number; pnlPct: number; levels: string[]; profit: number };
  recentTrades: Array<{ time: string; strategy: string; token: string; amount: number; out: number; price: number }>;
  // Strategy data
  arbOpps: Array<{ token: string; buy: string; sell: string; spread: number; profit: number; viable: boolean }>;
  yieldMarkets: Array<{ pair: string; apy: number; utilization: number; supply: number }>;
  predictions: Array<{ question: string; yes: number; no: number; mispricing: number; volume: string }>;
  // Scroll & selection
  tradeScrollOffset: number;
  arbSelectedIdx: number;
  // Action
  runOutput: string[];
  // Toast
  toast: { message: string; type: "info" | "success" | "error"; expiresAt: number } | null;
}

const DRY_RUN = process.argv.includes("--dry-run");

const state: AppState = {
  view: "dashboard",
  previousView: "dashboard",
  loading: true,
  lastRefresh: null,
  error: null,
  dryRun: DRY_RUN,
  prices: {},
  priceHistory: {},
  fear: { value: 50, classification: "Neutral" },
  rsi: 50,
  atrPct: 2.0,
  portfolio: { usdc: 0, eth: 0, total: 0, pnl: 0, pnlPct: 0, peak: 0, drawdown: 0 },
  brain: { trades: 0, dcaMult: 1, arbSpread: 0.1, adaptation: "" },
  grid: { price: 0, entry: 0, pnlPct: 0, levels: [], profit: 0 },
  recentTrades: [],
  arbOpps: [],
  yieldMarkets: [],
  predictions: [],
  tradeScrollOffset: 0,
  arbSelectedIdx: 0,
  runOutput: [],
  toast: null,
};

// ── Toast ──
function showToast(message: string, type: "info" | "success" | "error") {
  state.toast = { message, type, expiresAt: Date.now() + 3000 };
  render();
  setTimeout(() => { if (state.toast && Date.now() >= state.toast.expiresAt) { state.toast = null; render(); } }, 3100);
}

// ── Suppress stdout for noisy library calls ──
function silenced<T>(fn: () => T): T {
  const orig = console.log;
  console.log = () => {};
  try { return fn(); }
  finally { console.log = orig; }
}
async function silencedAsync<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); }
  finally { console.log = orig; }
}

// ── API client ──
function getClient() {
  return createClient({ apiKey: requireEnv("SUWAPPU_API_KEY") });
}

const apiKey = requireEnv("SUWAPPU_API_KEY");
const walletAddress = process.env.WALLET_ADDRESS || "";

async function fetchPrices(): Promise<Record<string, { usd: number; change_24h: number }>> {
  const res = await fetch("https://api.suwappu.bot/v1/agent/prices?symbols=ETH,BTC,SOL", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json() as any;
  return data.prices || {};
}

// ── Data loading ──
async function refreshDashboard() {
  state.loading = true;
  state.error = null;
  startSpinner();
  render();

  try {
    const brainState = loadState();
    syncFromDCAHistory(brainState);

    const [prices, fear, candlesResult, balances, ethHist, btcHist, solHist] = await Promise.all([
      fetchPrices().catch(() => state.prices),
      getFearIndex().catch(() => state.fear),
      getCandles("ETHUSDC", "4h", 15).catch(() => null),
      walletAddress
        ? Promise.all([getUSDCBalance(walletAddress), getETHBalance(walletAddress)]).catch(() => [-1, -1])
        : Promise.resolve([-1, -1]),
      getCandles("ETHUSDC", "1h", 24).catch(() => null),
      getCandles("BTCUSDC", "1h", 24).catch(() => null),
      getCandles("SOLUSDC", "1h", 24).catch(() => null),
    ]);

    state.prices = prices;
    state.fear = fear;
    state.priceHistory = {
      ETH: ethHist?.map((c) => c.close) ?? [],
      BTC: btcHist?.map((c) => c.close) ?? [],
      SOL: solHist?.map((c) => c.close) ?? [],
    };

    if (candlesResult) {
      state.rsi = calcRSI(candlesResult);
      state.atrPct = calcATRPct(candlesResult);
    }

    const ethPrice = prices.ETH?.usd ?? 0;
    const [usdcBal, ethBal] = balances;

    if (usdcBal >= 0 && ethBal >= 0) {
      updatePortfolio(brainState, usdcBal, ethBal, ethPrice);
      const totalVal = usdcBal + ethBal * ethPrice;
      const pnl = totalVal - brainState.portfolio.startingCapital;
      state.portfolio = {
        usdc: usdcBal,
        eth: ethBal,
        total: totalVal,
        pnl,
        pnlPct: brainState.portfolio.startingCapital > 0 ? (pnl / brainState.portfolio.startingCapital) * 100 : 0,
        peak: brainState.portfolio.peakValue,
        drawdown: brainState.portfolio.peakValue > 0 ? ((brainState.portfolio.peakValue - totalVal) / brainState.portfolio.peakValue) * 100 : 0,
      };
    }

    const adaptation = adaptParameters(brainState);
    state.brain = {
      trades: brainState.trades.length,
      dcaMult: brainState.adjustments.dcaAmountMultiplier,
      arbSpread: brainState.adjustments.minArbSpread,
      adaptation: adaptation.reason,
    };

    try {
      const gridResult = await silencedAsync(() => checkGrid({ json: true, brainState }));
      state.grid = {
        price: gridResult.currentPrice,
        entry: gridResult.avgEntry,
        pnlPct: gridResult.pnlPct,
        levels: [],
        profit: gridResult.totalProfit,
      };
    } catch {}

    state.recentTrades = brainState.trades
      .slice(-5)
      .reverse()
      .map((t) => ({
        time: fmtTime(t.timestamp),
        strategy: t.strategy.toUpperCase(),
        token: t.token,
        amount: t.amountIn,
        out: t.amountOut,
        price: t.priceAtEntry,
      }));

    saveState(brainState);
    state.lastRefresh = new Date();
    state.loading = false;
    stopSpinner();
    showToast("Refreshed", "success");
  } catch (e: any) {
    state.error = e.message;
    state.loading = false;
    stopSpinner();
    showToast(e.message?.slice(0, 40) ?? "Error", "error");
  }
}

async function loadArbData() {
  state.loading = true;
  startSpinner();
  render();
  try {
    const client = getClient();
    const opps = await silencedAsync(() => scanArb(client, { tokens: ["ETH", "SOL"], chains: ["base", "arbitrum", "optimism", "ethereum"], minSpread: 0, json: true }));
    state.arbOpps = opps.map((o) => ({
      token: o.token,
      buy: o.buyChain,
      sell: o.sellChain,
      spread: o.spreadPct,
      profit: o.estProfitPer1K,
      viable: o.viable,
    }));
  } catch (e: any) {
    state.error = e.message;
    showToast(e.message?.slice(0, 40) ?? "Error", "error");
  }
  state.loading = false;
  stopSpinner();
}

async function loadYieldData() {
  state.loading = true;
  startSpinner();
  render();
  try {
    const client = getClient();
    const markets = await silencedAsync(() => scanYield(client, { chain: 8453, top: 10, json: true }));
    state.yieldMarkets = markets.map((m) => ({
      pair: m.pair,
      apy: m.supplyApy,
      utilization: m.utilization,
      supply: m.totalSupply,
    }));
  } catch (e: any) {
    state.error = e.message;
    showToast(e.message?.slice(0, 40) ?? "Error", "error");
  }
  state.loading = false;
  stopSpinner();
}

async function loadPredictData() {
  state.loading = true;
  startSpinner();
  render();
  try {
    const client = getClient();
    const preds = await silencedAsync(() => scanPredictions(client, { top: 10, json: true }));
    state.predictions = preds.map((p) => ({
      question: p.question.length > 50 ? p.question.slice(0, 47) + "..." : p.question,
      yes: p.yesPrice,
      no: p.noPrice,
      mispricing: p.mispricing,
      volume: p.volume,
    }));
  } catch (e: any) {
    state.error = e.message;
    showToast(e.message?.slice(0, 40) ?? "Error", "error");
  }
  state.loading = false;
  stopSpinner();
}

async function executeArbOpp(opp: { token: string; buy: string; sell: string; spread: number; profit: number; viable: boolean }) {
  state.view = "running";
  state.runOutput = [];
  render();

  const client = getClient();
  const push = (s: string) => { state.runOutput.push(s); render(); };

  const arbOpp = {
    token: opp.token,
    buyChain: opp.buy,
    sellChain: opp.sell,
    buyPrice: 0,
    sellPrice: 0,
    spreadPct: opp.spread,
    estProfitPer1K: opp.profit,
    viable: opp.viable,
  };

  push(`${t.accent}\u25b8 Executing arb: ${opp.token} ${opp.buy} \u2192 ${opp.sell} (spread ${fmtPct(opp.spread)})${c.reset}`);
  push("");

  const result = await silencedAsync(() => executeArb(client, arbOpp, { amount: 100, dryRun: state.dryRun, json: true }));

  if (result.dryRun) {
    push(`${t.warning}DRY RUN${c.reset}`);
    push(`  Would buy ${result.toAmount ?? "?"} ${opp.token} on ${opp.buy} for $${result.amount}`);
    push(`  Then bridge to ${opp.sell} and sell`);
    push(`  Est. spread: ${fmtPct(opp.spread)} | Est. profit/1K: ${fmtUsd(opp.profit)}`);
  } else if (result.executed) {
    push(`${t.positive}\u2713 Buy leg executed${c.reset}`);
    push(`  Bought ${result.toAmount} ${opp.token} on ${opp.buy}`);
    push(`  TX: ${result.txHash}`);
    push("");
    push(`${t.warning}\u26a0 Bridge to ${opp.sell} and sell manually to complete arb${c.reset}`);
  } else {
    push(`${t.negative}\u2717 Failed: ${result.error ?? "unknown error"}${c.reset}`);
  }

  push("");
  push(`${t.muted}Press any key to return...${c.reset}`);
}

async function executeRun() {
  state.view = "running";
  state.runOutput = [];
  render();

  const client = getClient();
  const brainState = loadState();
  syncFromDCAHistory(brainState);

  const push = (s: string) => { state.runOutput.push(s); render(); };

  try {
    push(`${t.accent}\u25b8 Loading market data...${c.reset}`);
    const [prices, fear] = await Promise.all([fetchPrices(), getFearIndex()]);
    const ethPrice = prices.ETH?.usd ?? 0;

    let rsi = 50, atrPct = 2.0;
    try {
      const candles = await getCandles("ETHUSDC", "4h", 15);
      rsi = calcRSI(candles);
      atrPct = calcATRPct(candles);
    } catch {}

    push(`  ETH: ${fmtUsd(ethPrice)} | Fear: ${fear.value}/100 | RSI: ${rsi.toFixed(0)} | ATR: ${atrPct.toFixed(1)}%`);

    // DCA
    push("");
    push(`${t.warning}\u25b8 DCA Buy${c.reset}`);
    const fearMult = fearMultiplier(fear.value);
    const brainMult = brainState.adjustments.dcaAmountMultiplier;
    const rsiMult = rsiMultiplier(rsi);
    const rawAmount = Math.max(1, Math.round(2 * fearMult * brainMult * rsiMult));

    // Portfolio-proportional cap: max 5% of USDC per trade
    const usdcBal = walletAddress ? await silencedAsync(() => getUSDCBalance(walletAddress)) : -1;
    const portfolioCap = usdcBal > 0 ? Math.max(1, Math.floor(usdcBal * 0.05)) : Infinity;
    const amount = Math.min(rawAmount, portfolioCap);

    if (brainMult === 0) {
      push(`  ${t.negative}\u26a0 DCA PAUSED by drawdown circuit breaker${c.reset}`);
    } else if (rsiMult === 0) {
      push(`  ${t.warning}\u26a0 RSI ${rsi.toFixed(0)} > 70 \u2014 overbought, skipping${c.reset}`);
    } else {
      const capNote = rawAmount > portfolioCap ? ` ${t.muted}(capped from $${rawAmount}, 5% of $${Math.floor(usdcBal)})${c.reset}` : "";
      push(`  Fear: ${fearMult}x | RSI: ${rsiMult}x | Brain: ${brainMult.toFixed(2)}x \u2192 $${amount}${capNote}`);
      const dcaResult = await silencedAsync(() => executeDCA(client, { token: "ETH", amount: String(amount), chain: "base", dryRun: state.dryRun, json: true }));
      if (dcaResult.executed) {
        push(`  ${t.positive}\u2713 Bought ${dcaResult.toAmount} ETH @ ${fmtUsd(dcaResult.price)}${c.reset}`);
      } else if (dcaResult.skipped) {
        push(`  ${t.warning}\u26a0 Skipped: ${dcaResult.skipReason}${c.reset}`);
      }
    }

    // Grid
    push("");
    push(`${t.warning}\u25b8 Grid Take-Profit${c.reset}`);
    const gridResult = await silencedAsync(() => checkGrid({ execute: !state.dryRun, json: true, brainState }));
    push(`  Price: ${fmtUsd(gridResult.currentPrice)} | Entry: ${fmtUsd(gridResult.avgEntry)} | PnL: ${fmtPct(gridResult.pnlPct)}`);
    if (gridResult.totalProfit > 0) {
      push(`  ${t.positive}\u2713 Realized: ${fmtUsd(gridResult.totalProfit)}${c.reset}`);
    }

    // Brain
    push("");
    push(`${t.warning}\u25b8 Brain Learn${c.reset}`);
    const scored = await backfillRewards(brainState, async (token: string) => {
      const res = await fetch(`https://api.suwappu.bot/v1/agent/prices?symbols=${token}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json() as any;
      return data.prices?.[token]?.usd ?? 0;
    });
    const adaptation = adaptParameters(brainState);
    push(`  Scored ${scored} trade(s) | ${adaptation.reason}`);

    saveState(brainState);
    push("");
    push(`${t.positive}${c.bold}\u2713 Flywheel cycle complete${c.reset}`);
  } catch (e: any) {
    push(`${t.negative}\u2717 Error: ${e.message}${c.reset}`);
  }

  push("");
  push(`${t.muted}Press any key to return to dashboard...${c.reset}`);
}

// ── Tab bar ──
function renderTabBar(activeView: View, layout: Layout): string {
  const tabs: Array<{ label: string; view: View }> = [
    { label: "Dashboard", view: "dashboard" },
    { label: "Arbitrage", view: "arb" },
    { label: "Yield", view: "yield" },
    { label: "Predict", view: "predict" },
    { label: "Trades", view: "trades" },
  ];

  let out = moveTo(layout.tabBarRow, 1);
  out += `${t.border}${"─".repeat(layout.width)}${c.reset}`;
  out += moveTo(layout.tabBarRow + 1, 2);

  for (const tab of tabs) {
    if (tab.view === activeView) {
      out += `${t.tabActive} [${tab.label}] ${c.reset}`;
    } else {
      out += `${t.tabInactive}  ${tab.label}  ${c.reset}`;
    }
  }

  return out;
}

// ── Render ──
function render() {
  const layout = computeLayout();
  let out = clearScreen;

  // ── Header ──
  const title = " SUWAPPU FLYWHEEL ";
  out += moveTo(1, 1);
  out += `${t.headerBg}${t.headerFg}${c.bold}${title}${c.reset}`;
  out += `${t.muted} v1.0 ${c.reset}`;

  if (state.dryRun) {
    out += ` ${CSI}48;5;214m${c.black}${c.bold} DRY RUN ${c.reset}`;
  }

  // Spinner / status (compute position)
  const headerPrefix = title.length + " v1.0 ".length + (state.dryRun ? " DRY RUN ".length + 1 : 0) + 3;
  spinnerCol = headerPrefix;
  if (state.loading) {
    const frame = SPINNER_FRAMES[spinnerIdx];
    out += `  ${t.warning}${frame}${c.reset}`;
  } else {
    out += `  ${t.positive}\u25c9${c.reset}`;
  }

  const refreshStr = state.lastRefresh
    ? ` ${state.lastRefresh.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`
    : "";
  out += `${t.muted}${refreshStr}${c.reset}`;

  // ── Toast ──
  if (state.toast && Date.now() < state.toast.expiresAt) {
    const msg = ` ${state.toast.message} `;
    const toastColor = state.toast.type === "error" ? t.negative
      : state.toast.type === "success" ? t.positive
      : t.accent;
    const toastX = Math.max(1, layout.width - stripAnsi(msg).length - 1);
    out += text(toastX, 1, `${toastColor}${c.bold}${msg}${c.reset}`);
  }

  // ── Tab bar (not for running/confirm views) ──
  if (state.view !== "running" && state.view !== "confirm-run" && state.view !== "confirm-arb") {
    const displayView = state.view === "help" ? state.previousView : state.view;
    out += renderTabBar(displayView, layout);
  }

  // ── Error ──
  if (state.error && state.view !== "running") {
    out += text(2, layout.contentStart, `${t.negative}\u2717 ${state.error}${c.reset}`);
  }

  // ── View content ──
  switch (state.view) {
    case "dashboard":
      out += renderDashboard(layout);
      break;
    case "arb":
      out += renderArb(layout);
      break;
    case "yield":
      out += renderYield(layout);
      break;
    case "predict":
      out += renderPredict(layout);
      break;
    case "trades":
      out += renderTrades(layout);
      break;
    case "confirm-run":
      out += renderConfirm(layout);
      break;
    case "confirm-arb":
      out += renderArb(layout);
      out += renderConfirmArb(layout);
      break;
    case "running":
      out += renderRunning(layout);
      break;
    case "help":
      // Render underlying view first, then overlay
      switch (state.previousView) {
        case "dashboard": out += renderDashboard(layout); break;
        case "arb": out += renderArb(layout); break;
        case "yield": out += renderYield(layout); break;
        case "predict": out += renderPredict(layout); break;
        case "trades": out += renderTrades(layout); break;
      }
      out += renderHelp(layout);
      break;
  }

  // ── Footer ──
  if (state.view !== "running" && state.view !== "confirm-run" && state.view !== "confirm-arb" && state.view !== "help") {
    out += renderFooter(state.view, layout);
  }

  process.stdout.write(out);
}

// ── Footer ──
function renderFooter(view: View, layout: Layout): string {
  let out = "";
  out += moveTo(layout.footerSepRow, 1) + `${t.border}${"─".repeat(layout.width)}${c.reset}`;
  out += moveTo(layout.footerRow, 1) + `${t.footerBg}${" ".repeat(layout.width)}${c.reset}`;
  out += moveTo(layout.footerRow, 2);

  type KeyHint = { key: string; label: string };
  let keys: KeyHint[] = [];

  if (view === "dashboard") {
    keys = [
      { key: "R", label: "Run" },
      { key: "A", label: "Arb" },
      { key: "Y", label: "Yield" },
      { key: "P", label: "Predict" },
      { key: "T", label: "Trades" },
      { key: "F", label: "Refresh" },
      { key: "H", label: "Help" },
      { key: "Q", label: "Quit" },
    ];
  } else if (view === "arb") {
    keys = [
      { key: "ESC", label: "Back" },
      { key: "j/k", label: "Select" },
      { key: "E", label: "Execute" },
      { key: "F", label: "Refresh" },
      { key: "H", label: "Help" },
      { key: "Q", label: "Quit" },
    ];
  } else if (view === "trades") {
    keys = [
      { key: "ESC", label: "Back" },
      { key: "j/k", label: "Scroll" },
      { key: "F", label: "Refresh" },
      { key: "H", label: "Help" },
      { key: "Q", label: "Quit" },
    ];
  } else {
    keys = [
      { key: "ESC", label: "Back" },
      { key: "F", label: "Refresh" },
      { key: "H", label: "Help" },
      { key: "Q", label: "Quit" },
    ];
  }

  for (const k of keys) {
    out += `${t.footerBg}${t.accent}${c.bold}${k.key}${c.reset}${t.footerBg}${t.footerFg} ${k.label}  ${c.reset}`;
  }

  return out;
}

// ── Dashboard ──
function renderDashboard(layout: Layout): string {
  let out = "";
  const w = layout.width;
  let row = layout.contentStart + 1;

  if (layout.twoCol) {
    // ── Two-column layout ──
    const lw = layout.halfW;
    const rw = layout.halfW;
    const rx = lw + 3;

    // Left column: PORTFOLIO
    const pRows = 5;
    out += box(1, row, lw + 1, pRows, { title: "PORTFOLIO", color: t.borderActive });
    const { usdc, eth, total, pnl, pnlPct, peak, drawdown } = state.portfolio;
    out += text(3, row + 1, `${t.value}${fmtUsd(total)}${c.reset}  ${fmtPctColor(pnlPct)} all-time`);
    out += text(3, row + 2, `${t.label}USDC${c.reset} ${fmtUsd(usdc)}  ${t.label}ETH${c.reset} ${eth.toFixed(4)} (${fmtUsd(eth * (state.prices.ETH?.usd ?? 0))})`);
    out += text(3, row + 3, `${t.label}Peak${c.reset} ${fmtUsd(peak)}  ${t.label}DD${c.reset} ${drawdown > 5 ? t.negative : t.muted}${drawdown.toFixed(1)}%${c.reset}`);

    // Right column: BRAIN
    const bRows = 5;
    out += box(rx, row, rw + 1, bRows, { title: "BRAIN", color: t.border });
    out += text(rx + 2, row + 1, `${t.label}Trades${c.reset} ${state.brain.trades}  ${t.label}DCA${c.reset} ${state.brain.dcaMult.toFixed(2)}x  ${t.label}Arb min${c.reset} ${state.brain.arbSpread.toFixed(2)}%`);
    if (state.brain.adaptation) {
      out += text(rx + 2, row + 2, `${t.label}Adapt${c.reset} ${state.brain.adaptation}`);
    }
    if (state.grid.entry > 0) {
      out += text(rx + 2, row + 3, `${t.label}Grid${c.reset} ${fmtUsd(state.grid.price)} | ${t.label}Entry${c.reset} ${fmtUsd(state.grid.entry)} | ${fmtPctColor(state.grid.pnlPct)} | ${t.label}Real${c.reset} ${fmtUsd(state.grid.profit)}`);
    }

    row += pRows + 1;

    // Full-width: MARKET
    const mRows = Object.keys(state.prices).length + 5;
    out += box(1, row, w, mRows, { title: "MARKET", color: t.border });
    let mRow = row + 1;
    for (const [token, data] of Object.entries(state.prices)) {
      const change = data.change_24h ?? 0;
      const hist = state.priceHistory[token] ?? [];
      out += text(3, mRow, `${t.value}${pad(token, 5)}${c.reset} ${rpad(fmtUsd(data.usd), 10)}  ${sparkline(hist, 16)}  ${fmtPctColor(change)}`);
      mRow++;
    }
    mRow++;
    const fMult = fearMultiplier(state.fear.value);
    out += text(3, mRow, `${t.label}Fear${c.reset} ${fearBar(state.fear.value)} ${state.fear.value}/100 ${t.muted}(${state.fear.classification})${c.reset}  ${t.label}DCA${c.reset} ${fMult >= 2 ? t.positive : fMult <= 0.5 ? t.negative : t.warning}${fMult}x${c.reset}`);
    mRow++;
    out += text(3, mRow, `${t.label}RSI${c.reset}  ${rsiBar(state.rsi)} ${state.rsi.toFixed(0)} ${t.muted}(${rsiMultiplier(state.rsi)}x)${c.reset}  ${t.label}ATR${c.reset} ${state.atrPct.toFixed(1)}%`);

    row += mRows + 1;

    // Full-width: RECENT TRADES
    if (state.recentTrades.length > 0) {
      const tRows = state.recentTrades.slice(0, 4).length + 2;
      out += box(1, row, w, tRows, { title: "RECENT TRADES", subtitle: `last ${state.recentTrades.length}`, color: t.border });
      let tRow = row + 1;
      for (const tr of state.recentTrades.slice(0, 4)) {
        out += text(3, tRow, `${t.muted}${tr.time}${c.reset}  ${t.warning}${pad(tr.strategy, 4)}${c.reset}  ${tr.token} ${fmtUsd(tr.amount)} \u2192 ${tr.out.toFixed(6)} @ ${fmtUsd(tr.price)}`);
        tRow++;
      }
    }
  } else {
    // ── Single-column layout ──

    // PORTFOLIO
    const pRows = 5;
    out += box(1, row, w, pRows, { title: "PORTFOLIO", color: t.borderActive });
    const { usdc, eth, total, pnl, pnlPct, peak, drawdown } = state.portfolio;
    out += text(3, row + 1, `${t.value}${fmtUsd(total)}${c.reset}  ${fmtPctColor(pnlPct)} all-time`);
    out += text(3, row + 2, `${t.label}USDC${c.reset} ${fmtUsd(usdc)}  ${t.label}ETH${c.reset} ${eth.toFixed(4)} (${fmtUsd(eth * (state.prices.ETH?.usd ?? 0))})`);
    out += text(3, row + 3, `${t.label}Peak${c.reset} ${fmtUsd(peak)}  ${t.label}Drawdown${c.reset} ${drawdown > 5 ? t.negative : t.muted}${drawdown.toFixed(1)}%${c.reset}`);
    row += pRows;

    // MARKET
    const priceCount = Object.keys(state.prices).length;
    const mRows = priceCount + 6;
    out += box(1, row, w, mRows, { title: "MARKET", color: t.border });
    let mRow = row + 1;
    for (const [token, data] of Object.entries(state.prices)) {
      const change = data.change_24h ?? 0;
      const hist = state.priceHistory[token] ?? [];
      out += text(3, mRow, `${t.value}${pad(token, 5)}${c.reset} ${rpad(fmtUsd(data.usd), 10)}  ${sparkline(hist, 12)}  ${fmtPctColor(change)}`);
      mRow++;
    }
    mRow++;
    const fMult = fearMultiplier(state.fear.value);
    out += text(3, mRow, `${t.label}Fear & Greed${c.reset}  ${fearBar(state.fear.value)}  ${state.fear.value}/100 ${t.muted}(${state.fear.classification})${c.reset}`);
    mRow++;
    out += text(3, mRow, `${t.label}DCA mult${c.reset} ${fMult >= 2 ? t.positive : fMult <= 0.5 ? t.negative : t.warning}${fMult}x${c.reset}`);
    mRow++;
    out += text(3, mRow, `${t.label}RSI (14, 4h)${c.reset}  ${rsiBar(state.rsi)}  ${state.rsi.toFixed(0)} ${t.muted}(${rsiMultiplier(state.rsi)}x)${c.reset}`);
    mRow++;
    out += text(3, mRow, `${t.label}ATR (14, 4h)${c.reset}  ${state.atrPct.toFixed(1)}%`);
    row += mRows;

    // BRAIN
    const brainLines = state.brain.adaptation ? 2 : 1;
    const gridLine = state.grid.entry > 0 ? 1 : 0;
    const bRows = brainLines + gridLine + 2;
    out += box(1, row, w, bRows, { title: "BRAIN", color: t.border });
    let bRow = row + 1;
    out += text(3, bRow, `${t.label}Trades${c.reset} ${state.brain.trades}  ${t.label}DCA mult${c.reset} ${state.brain.dcaMult.toFixed(2)}x  ${t.label}Min arb spread${c.reset} ${state.brain.arbSpread.toFixed(2)}%`);
    bRow++;
    if (state.brain.adaptation) {
      out += text(3, bRow, `${t.label}Adapt${c.reset} ${state.brain.adaptation}`);
      bRow++;
    }
    if (state.grid.entry > 0) {
      out += text(3, bRow, `${t.label}Grid${c.reset} ${fmtUsd(state.grid.price)}  ${t.label}Entry${c.reset} ${fmtUsd(state.grid.entry)}  ${fmtPctColor(state.grid.pnlPct)}  ${t.label}Realized${c.reset} ${fmtUsd(state.grid.profit)}`);
    }
    row += bRows;

    // RECENT TRADES
    if (state.recentTrades.length > 0) {
      const tRows = state.recentTrades.slice(0, 4).length + 2;
      out += box(1, row, w, tRows, { title: "RECENT TRADES", subtitle: `last ${state.recentTrades.length}`, color: t.border });
      let tRow = row + 1;
      for (const tr of state.recentTrades.slice(0, 4)) {
        out += text(3, tRow, `${t.muted}${tr.time}${c.reset}  ${t.warning}${pad(tr.strategy, 4)}${c.reset}  ${tr.token} ${fmtUsd(tr.amount)} \u2192 ${tr.out.toFixed(6)} @ ${fmtUsd(tr.price)}`);
        tRow++;
      }
    }
  }

  return out;
}

// ── Arbitrage View ──
function renderArb(layout: Layout): string {
  let out = "";
  const w = layout.width;
  let row = layout.contentStart + 1;

  // Summary panel
  const viable = state.arbOpps.filter((o) => o.viable).length;
  const best = state.arbOpps.reduce((b, o) => (o.spread > b.spread ? o : b), { spread: 0, token: "-", buy: "", sell: "" } as any);
  out += box(1, row, w, 3, { title: "CROSS-CHAIN ARBITRAGE", color: t.borderActive });
  if (state.loading) {
    out += text(3, row + 1, `${t.warning}Scanning across chains...${c.reset}`);
  } else {
    out += text(3, row + 1,
      `${t.label}Opportunities${c.reset} ${state.arbOpps.length}  ${t.label}Viable${c.reset} ${viable > 0 ? `${t.positive}${viable}` : `${t.muted}0`}${c.reset}  ${t.label}Best${c.reset} ${best.spread > 0 ? `${t.positive}${fmtPct(best.spread)}${c.reset} ${t.muted}(${best.token} ${best.buy}\u2192${best.sell})${c.reset}` : `${t.muted}none${c.reset}`}`
    );
  }
  row += 4;

  if (state.loading || state.arbOpps.length === 0) return out;

  // Clamp selection
  state.arbSelectedIdx = Math.max(0, Math.min(state.arbSelectedIdx, state.arbOpps.length - 1));

  // Table header
  out += text(3, row, `${t.label}  ${pad("Token", 6)} ${pad("Buy", 10)} ${pad("Sell", 10)} ${pad("Spread", 10)} ${pad("Est $/1K", 10)} ${pad("Status", 8)}${c.reset}`);
  row++;
  out += text(3, row, `${t.border}${"─".repeat(62)}${c.reset}`);
  row++;

  for (let i = 0; i < state.arbOpps.length; i++) {
    const opp = state.arbOpps[i];
    const spreadColor = opp.viable ? t.positive : opp.spread > 0 ? t.warning : t.negative;
    const status = opp.viable ? `${t.positive}VIABLE${c.reset}` : `${t.muted}low${c.reset}`;
    const cursor = i === state.arbSelectedIdx ? `${t.accent}\u25b6 ${c.reset}` : "  ";
    const highlight = i === state.arbSelectedIdx ? `${CSI}48;5;236m` : "";
    out += text(3, row,
      `${highlight}${cursor}${t.value}${pad(opp.token, 6)}${c.reset}${highlight} ${pad(opp.buy, 10)} ${pad(opp.sell, 10)} ${spreadColor}${pad(fmtPct(opp.spread), 10)}${c.reset}${highlight} ${pad(fmtUsd(opp.profit), 10)} ${status}${c.reset}`
    );
    row++;
  }

  return out;
}

// ── Yield View ──
function renderYield(layout: Layout): string {
  let out = "";
  const w = layout.width;
  let row = layout.contentStart + 1;

  // Summary panel
  const bestApy = state.yieldMarkets.reduce((b, m) => Math.max(b, m.apy), 0);
  const bestPair = state.yieldMarkets.find((m) => m.apy === bestApy)?.pair ?? "-";
  const avgApy = state.yieldMarkets.length > 0
    ? state.yieldMarkets.reduce((s, m) => s + m.apy, 0) / state.yieldMarkets.length
    : 0;

  out += box(1, row, w, 3, { title: "LENDING YIELDS (Base)", subtitle: "MONITOR", color: t.borderActive });
  if (state.loading) {
    out += text(3, row + 1, `${t.warning}Scanning Morpho markets...${c.reset}`);
  } else {
    out += text(3, row + 1,
      `${t.label}Markets${c.reset} ${state.yieldMarkets.length}  ${t.label}Best APY${c.reset} ${t.positive}${fmtPct(bestApy, false)}${c.reset} ${t.muted}(${bestPair})${c.reset}  ${t.label}Avg${c.reset} ${fmtPct(avgApy, false)}`
    );
  }
  row += 4;

  if (state.loading || state.yieldMarkets.length === 0) return out;

  out += text(3, row, `${t.label}${pad("Pair", 25)} ${pad("Supply APY", 12)} ${pad("Utilization", 12)} ${pad("TVL", 12)}${c.reset}`);
  row++;
  out += text(3, row, `${t.border}${"─".repeat(65)}${c.reset}`);
  row++;

  for (const m of state.yieldMarkets) {
    const apyColor = m.apy >= 5 ? t.positive : m.apy >= 2 ? t.warning : t.muted;
    out += text(3, row,
      `${pad(m.pair, 25)} ${apyColor}${pad(fmtPct(m.apy, false), 12)}${c.reset} ${pad(fmtPct(m.utilization * 100, false), 12)} ${pad(fmtUsd(m.supply), 12)}`
    );
    row++;
  }

  return out;
}

// ── Prediction Markets View ──
function renderPredict(layout: Layout): string {
  let out = "";
  const w = layout.width;
  let row = layout.contentStart + 1;

  // Summary
  const mispriced = state.predictions.filter((p) => p.mispricing > 2).length;
  const bestEdge = state.predictions.reduce((b, p) => Math.max(b, p.mispricing), 0);

  out += box(1, row, w, 3, { title: "PREDICTION MARKETS", subtitle: "MONITOR", color: t.borderActive });
  if (state.loading) {
    out += text(3, row + 1, `${t.warning}Scanning Polymarket...${c.reset}`);
  } else {
    out += text(3, row + 1,
      `${t.label}Markets${c.reset} ${state.predictions.length}  ${t.label}Mispriced (>2%)${c.reset} ${mispriced > 0 ? `${t.positive}${mispriced}` : `${t.muted}0`}${c.reset}  ${t.label}Best Edge${c.reset} ${bestEdge > 0 ? `${t.positive}${fmtPct(bestEdge)}${c.reset}` : `${t.muted}none${c.reset}`}`
    );
  }
  row += 4;

  if (state.loading || state.predictions.length === 0) return out;

  out += text(3, row, `${t.label}${pad("Market", 52)} ${pad("YES", 6)} ${pad("NO", 6)} ${pad("Edge", 8)} ${pad("Vol", 8)}${c.reset}`);
  row++;
  out += text(3, row, `${t.border}${"─".repeat(82)}${c.reset}`);
  row++;

  for (const p of state.predictions) {
    const edgeColor = p.mispricing > 2 ? t.positive : p.mispricing > 0 ? t.warning : t.muted;
    out += text(3, row,
      `${pad(p.question, 52)} ${pad(`${(p.yes * 100).toFixed(0)}\u00a2`, 6)} ${pad(`${(p.no * 100).toFixed(0)}\u00a2`, 6)} ${edgeColor}${pad(fmtPct(p.mispricing), 8)}${c.reset} ${pad(p.volume, 8)}`
    );
    row++;
  }

  return out;
}

// ── Trade History (scrollable) ──
function renderTrades(layout: Layout): string {
  let out = "";
  const w = layout.width;
  let row = layout.contentStart + 1;

  const brainState = loadState();
  const trades = brainState.trades.slice().reverse();

  // Summary panel
  const profitable = trades.filter((t) => t.profitable === true).length;
  const totalPnl = trades.reduce((s, t) => s + (t.reward !== undefined ? t.reward : 0), 0);

  out += box(1, row, w, 3, { title: "TRADE HISTORY", color: t.borderActive });
  out += text(3, row + 1,
    `${t.label}Total${c.reset} ${trades.length}  ${t.label}Profitable${c.reset} ${profitable > 0 ? `${t.positive}${profitable}` : `${t.muted}0`}${c.reset}  ${t.label}Avg Reward${c.reset} ${trades.length > 0 ? fmtPct((totalPnl / trades.length) * 100) : "—"}`
  );
  row += 4;

  if (trades.length === 0) {
    out += text(3, row, `${t.muted}No trades yet.${c.reset}`);
    return out;
  }

  // Header
  out += text(3, row, `${t.label}${pad("Date", 16)} ${pad("Type", 6)} ${pad("Token", 6)} ${pad("In", 8)} ${pad("Out", 12)} ${pad("Price", 10)} ${pad("Fear", 5)} ${pad("Reward", 8)}${c.reset}`);
  row++;
  out += text(3, row, `${t.border}${"─".repeat(75)}${c.reset}`);
  row++;

  const visibleRows = layout.contentEnd - row - 1;
  const maxOffset = Math.max(0, trades.length - visibleRows);
  state.tradeScrollOffset = Math.min(state.tradeScrollOffset, maxOffset);
  const startIdx = state.tradeScrollOffset;
  const endIdx = Math.min(startIdx + visibleRows, trades.length);
  const visibleTrades = trades.slice(startIdx, endIdx);

  const tableStartRow = row;
  for (const tr of visibleTrades) {
    const rewardStr = tr.reward !== undefined ? fmtPct(tr.reward * 100) : "\u2014";
    const rewardColor = tr.profitable === true ? t.positive : tr.profitable === false ? t.negative : t.muted;
    out += text(3, row,
      `${t.muted}${pad(fmtTime(tr.timestamp), 16)}${c.reset} ${t.warning}${pad(tr.strategy.toUpperCase(), 6)}${c.reset} ${pad(tr.token, 6)} ${pad(fmtUsd(tr.amountIn), 8)} ${pad(tr.amountOut.toFixed(6), 12)} ${pad(fmtUsd(tr.priceAtEntry), 10)} ${pad(String(tr.fearIndex), 5)} ${rewardColor}${pad(rewardStr, 8)}${c.reset}`
    );
    row++;
  }

  // Scrollbar
  if (trades.length > visibleRows) {
    const sbHeight = Math.max(1, Math.floor((visibleRows / trades.length) * visibleRows));
    const sbPos = Math.floor((startIdx / Math.max(1, trades.length - visibleRows)) * (visibleRows - sbHeight));
    for (let i = 0; i < visibleRows && i < endIdx - startIdx; i++) {
      const char = (i >= sbPos && i < sbPos + sbHeight) ? "\u2588" : "\u2591";
      out += text(w - 1, tableStartRow + i, `${t.muted}${char}${c.reset}`);
    }
  }

  // Footer
  row = layout.contentEnd;
  out += text(3, row, `${t.muted}Showing ${startIdx + 1}-${endIdx} of ${trades.length}${trades.length > visibleRows ? " | j/k to scroll" : ""}${c.reset}`);

  return out;
}

// ── Confirm dialog ──
function renderConfirm(layout: Layout): string {
  let out = "";
  const w = 54;
  const h = 7;
  const x = Math.floor((layout.width - w) / 2);
  const y = Math.floor((layout.height - h) / 2);

  out += box(x, y, w, h, { title: "CONFIRM EXECUTION", color: t.warning });
  let row = y + 2;
  out += text(x + 3, row, `${t.value}Run the full flywheel cycle?${c.reset}`);
  row++;
  if (state.dryRun) {
    out += text(x + 3, row, `${t.accent}This will execute in DRY RUN mode (no real trades).${c.reset}`);
  } else {
    out += text(x + 3, row, `${t.warning}This will execute LIVE trades.${c.reset}`);
  }
  row += 2;
  out += text(x + 3, row, `${t.positive}[Y]${c.reset} Yes, execute  ${t.negative}[N]${c.reset} Cancel`);

  return out;
}

// ── Confirm arb execution ──
function renderConfirmArb(layout: Layout): string {
  let out = "";
  const opp = state.arbOpps[state.arbSelectedIdx];
  if (!opp) return out;

  const w = 60;
  const h = 10;
  const x = Math.floor((layout.width - w) / 2);
  const y = Math.floor((layout.height - h) / 2);

  out += box(x, y, w, h, { title: "EXECUTE ARB", color: t.warning });
  let row = y + 2;
  out += text(x + 3, row, `${t.value}${opp.token}${c.reset} ${opp.buy} \u2192 ${opp.sell}  spread ${fmtPctColor(opp.spread)}`);
  row++;
  out += text(x + 3, row, `${t.label}Est. profit/1K:${c.reset} ${opp.profit > 0 ? `${t.positive}${fmtUsd(opp.profit)}` : `${t.negative}${fmtUsd(opp.profit)}`}${c.reset}`);
  row++;
  if (state.dryRun) {
    out += text(x + 3, row, `${t.accent}DRY RUN mode \u2014 no real trade${c.reset}`);
  } else {
    out += text(x + 3, row, `${t.warning}LIVE \u2014 will execute buy leg on ${opp.buy}${c.reset}`);
    row++;
    out += text(x + 3, row, `${t.muted}Bridge + sell on ${opp.sell} is manual${c.reset}`);
  }
  row += 2;
  out += text(x + 3, row, `${t.positive}[Y]${c.reset} Execute  ${t.negative}[N]${c.reset} Cancel`);

  return out;
}

// ── Running view ──
function renderRunning(layout: Layout): string {
  let out = "";
  let row = layout.contentStart;

  out += text(2, row, `${t.borderActive}${c.bold}FLYWHEEL EXECUTION${c.reset}`);
  if (state.dryRun) {
    out += ` ${t.accent}(dry run)${c.reset}`;
  }
  row += 2;

  for (const line of state.runOutput) {
    out += text(3, row, line);
    row++;
  }

  return out;
}

// ── Help overlay ──
function renderHelp(layout: Layout): string {
  const w = 52;
  const h = 19;
  const x = Math.floor((layout.width - w) / 2);
  const y = Math.floor((layout.height - h) / 2);

  let out = box(x, y, w, h, { title: "KEYBINDINGS", color: t.borderActive });

  const bindings: [string, string][] = [
    ["D / ESC", "Dashboard"],
    ["A", "Arbitrage scanner"],
    ["Y", "Yield markets (monitor)"],
    ["P", "Prediction markets (monitor)"],
    ["T", "Trade history"],
    ["R", "Run flywheel cycle"],
    ["E", "Execute selected arb"],
    ["F", "Refresh current view"],
    ["H", "Toggle this help"],
    ["j / \u2193", "Select / Scroll down"],
    ["k / \u2191", "Select / Scroll up"],
    ["Q", "Quit"],
  ];

  let row = y + 2;
  for (const [key, desc] of bindings) {
    out += text(x + 3, row, `${t.accent}${c.bold}${pad(key, 10)}${c.reset} ${t.muted}${desc}${c.reset}`);
    row++;
  }

  row++;
  out += text(x + 3, row, `${t.muted}Press H or ESC to close${c.reset}`);

  return out;
}

// ── Input handling ──
async function handleKey(key: Buffer) {
  const str = key.toString();
  const code = key[0];

  // Ctrl+C
  if (code === 3) {
    shutdown();
    return;
  }

  // Q to quit (not in confirm/running/help)
  if (str === "q" && state.view !== "confirm-run" && state.view !== "confirm-arb" && state.view !== "running" && state.view !== "help") {
    shutdown();
    return;
  }

  // Help toggle
  if (str.toLowerCase() === "h" && state.view !== "running" && state.view !== "confirm-run" && state.view !== "confirm-arb") {
    if (state.view === "help") {
      state.view = state.previousView;
    } else {
      state.previousView = state.view;
      state.view = "help";
    }
    render();
    return;
  }

  // ESC
  if (code === 27 && key.length === 1) {
    if (state.view === "help") {
      state.view = state.previousView;
    } else if (state.view === "confirm-arb") {
      state.view = "arb";
    } else if (state.view !== "dashboard") {
      state.view = "dashboard";
      state.tradeScrollOffset = 0;
      state.error = null;
    }
    render();
    return;
  }

  // Running view — any key returns
  if (state.view === "running" && state.runOutput.length > 0 && state.runOutput[state.runOutput.length - 1].includes("Press any key")) {
    // If we came from arb execution, go back to arb
    if (state.runOutput.some((l) => l.includes("arb") || l.includes("buy leg"))) {
      state.view = "arb";
      await loadArbData();
    } else {
      state.view = "dashboard";
      await refreshDashboard();
    }
    render();
    return;
  }

  // Confirm views
  if (state.view === "confirm-run") {
    if (str === "y" || str === "Y") {
      await executeRun();
    } else {
      state.view = "dashboard";
      render();
    }
    return;
  }

  if (state.view === "confirm-arb") {
    if (str === "y" || str === "Y") {
      const opp = state.arbOpps[state.arbSelectedIdx];
      if (opp) await executeArbOpp(opp);
    } else {
      state.view = "arb";
      render();
    }
    return;
  }

  // Help view — any non-H/ESC key closes and processes
  if (state.view === "help") {
    state.view = state.previousView;
    render();
    return;
  }

  // Arb view — j/k to select, E to execute
  if (state.view === "arb" && state.arbOpps.length > 0) {
    const isDown = str === "j" || (key.length === 3 && key[0] === 27 && key[1] === 91 && key[2] === 66);
    const isUp = str === "k" || (key.length === 3 && key[0] === 27 && key[1] === 91 && key[2] === 65);
    if (isDown) {
      state.arbSelectedIdx = Math.min(state.arbSelectedIdx + 1, state.arbOpps.length - 1);
      render();
      return;
    }
    if (isUp) {
      state.arbSelectedIdx = Math.max(0, state.arbSelectedIdx - 1);
      render();
      return;
    }
    if (str.toLowerCase() === "e") {
      state.view = "confirm-arb";
      render();
      return;
    }
  }

  // Scroll in trades view (j/k and arrow keys)
  if (state.view === "trades") {
    const isDown = str === "j" || (key.length === 3 && key[0] === 27 && key[1] === 91 && key[2] === 66);
    const isUp = str === "k" || (key.length === 3 && key[0] === 27 && key[1] === 91 && key[2] === 65);
    if (isDown || isUp) {
      const brainState = loadState();
      const totalTrades = brainState.trades.length;
      const layout = computeLayout();
      const tableHeaderRows = 6; // summary panel + header
      const visibleRows = layout.contentEnd - layout.contentStart - tableHeaderRows;
      const maxOffset = Math.max(0, totalTrades - visibleRows);
      if (isDown) {
        state.tradeScrollOffset = Math.min(state.tradeScrollOffset + 1, maxOffset);
      } else {
        state.tradeScrollOffset = Math.max(0, state.tradeScrollOffset - 1);
      }
      render();
      return;
    }
  }

  // Dashboard keys
  if (state.view === "dashboard") {
    switch (str.toLowerCase()) {
      case "r":
        state.view = "confirm-run";
        render();
        break;
      case "a":
        state.view = "arb";
        render();
        await loadArbData();
        render();
        break;
      case "y":
        state.view = "yield";
        render();
        await loadYieldData();
        render();
        break;
      case "p":
        state.view = "predict";
        render();
        await loadPredictData();
        render();
        break;
      case "t":
        state.view = "trades";
        state.tradeScrollOffset = 0;
        render();
        break;
      case "d":
        // Already on dashboard, just refresh
        await refreshDashboard();
        render();
        break;
      case "f":
        await refreshDashboard();
        render();
        break;
    }
  } else if (str.toLowerCase() === "f") {
    switch (state.view) {
      case "arb": await loadArbData(); break;
      case "yield": await loadYieldData(); break;
      case "predict": await loadPredictData(); break;
    }
    render();
  }

  // Navigate to views from any view
  if (state.view !== "dashboard" && state.view !== "running" && state.view !== "confirm-run") {
    switch (str.toLowerCase()) {
      case "a":
        if (state.view !== "arb") { state.view = "arb"; render(); await loadArbData(); render(); }
        break;
      case "y":
        if (state.view !== "yield") { state.view = "yield"; render(); await loadYieldData(); render(); }
        break;
      case "p":
        if (state.view !== "predict") { state.view = "predict"; render(); await loadPredictData(); render(); }
        break;
      case "t":
        if (state.view !== "trades") { state.view = "trades"; state.tradeScrollOffset = 0; render(); }
        break;
      case "d":
        state.view = "dashboard"; state.tradeScrollOffset = 0; render();
        break;
    }
  }
}

// ── Lifecycle ──
function shutdown() {
  stopSpinner();
  process.stdout.write(altScreenOff + cursorShow);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}

async function main() {
  process.stdout.write(altScreenOn + cursorHide);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handleKey);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("resize", () => { render(); });

  render();
  await refreshDashboard();
  render();

  // Auto-refresh every 60s
  setInterval(async () => {
    if (state.view === "dashboard" && !state.loading) {
      await refreshDashboard();
      render();
    }
  }, 60_000);
}

main().catch((e) => {
  stopSpinner();
  process.stdout.write(altScreenOff + cursorShow);
  console.error(e);
  process.exit(1);
});
