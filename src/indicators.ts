/**
 * Technical indicators — RSI and ATR from Binance 4h candles.
 * No API key needed (public endpoints).
 */

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Fetch 4h candles from Binance */
export async function getCandles(symbol = "ETHUSDC", interval = "4h", limit = 15): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json() as number[][];
  return data.map(c => ({
    open: parseFloat(String(c[1])),
    high: parseFloat(String(c[2])),
    low: parseFloat(String(c[3])),
    close: parseFloat(String(c[4])),
  }));
}

/** RSI(14) — returns 0-100 */
export function calcRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50; // not enough data

  const changes: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  // Initial average gain/loss
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smoothed (Wilder's method)
  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** ATR(14) as percentage of current price */
export function calcATRPct(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 2.0; // default 2%

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trueRanges.push(tr);
  }

  // Simple average for initial ATR
  const count = Math.min(trueRanges.length, period);
  const atr = trueRanges.slice(-count).reduce((s, v) => s + v, 0) / count;
  const currentPrice = candles[candles.length - 1].close;

  return currentPrice > 0 ? (atr / currentPrice) * 100 : 2.0;
}

/** RSI multiplier for DCA sizing: buy more when oversold, less when overbought */
export function rsiMultiplier(rsi: number): number {
  if (rsi > 70) return 0;      // Overbought → skip
  if (rsi > 50) return 0.5;    // Neutral-high → half size
  if (rsi > 30) return 1.0;    // Neutral-low → full size
  return 1.5;                   // Oversold → 1.5x size
}

/** Dynamic grid spacing from ATR — returns [level1, level2, level3] as decimals */
export function dynamicGridLevels(atrPct: number): [number, number, number] {
  // spacing = ATR * 0.6, clamped to [1.0%, 4.0%]
  const spacing = Math.max(1.0, Math.min(4.0, atrPct * 0.6));
  return [
    spacing / 100,        // Level 1: 1x spacing
    (spacing * 2) / 100,  // Level 2: 2x spacing
    (spacing * 3) / 100,  // Level 3: 3x spacing
  ];
}
