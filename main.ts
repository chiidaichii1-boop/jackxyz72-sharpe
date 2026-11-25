// Steady Ladder — paper-trading bot for the Pump.fun Sharpe Sprint
// (make.fun bounty u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
//
// The harness speaks agent-fun/replay/v2 over stdin/stdout: one `hello`
// line, then one `batch` per slot, then `done`. For every batch the bot
// answers with exactly one reply listing the orders it wants placed in
// that slot; fills for those orders land a couple of slots later
// (latency_slots = 2 in the hello).
//
// The ranking is hourly Sharpe ratio, so the bot chases many small,
// controlled round trips instead of one lucky moonshot:
//
//   * Entry — buy the dip after proven demand: a mint created within the
//     last ~1800 slots that first climbed at least +10% from its first
//     print, then pulled back at least 4% from its peak, with the latest
//     print bouncing off the dip. At least 3 trades on the curve. One buy
//     per mint per run, so a coin is never chased twice. Fixed size
//     0.03 SOL, clipped to the harness per-mint cap, skipped when the
//     clipped size would fall under 0.015 SOL (fees would eat it).
//   * Exits — the whole position goes on the first rule that fires:
//     take profit +10% over the entry price, hard stop -5%, trailing stop
//     once the peak gain reached +5% (sell on a 3% pullback from the
//     peak), or a time stop after 300 slots so capital rotates on.
//   * Risk — at most 5 open positions, buys only from free cash, 800 bps
//     max slippage on buys and 1200 bps on sells (a full-position sell
//     moves its own curve, and a rejected sell must not strand the
//     position).
//
// Determinism: no clock, no environment reads for decisions, no
// Math.random. Every decision is a pure function of the hello/batch
// stream, so two runs on the same input give byte-identical action logs.
//
// The replay harness itself uses stdin/stdout, but this entrypoint also
// honours MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR (falling back to
// /input and /output). On `done` it best-effort writes a small run
// summary JSON into the output directory — creating the directory if it
// is missing, and NEVER deleting it or anything inside it.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState } from './vendor/makefun-bot.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ------------------------------------------------------------------ config

const BUY_SIZE = 30_000_000n; // 0.03 SOL per buy
const MIN_BUY = 15_000_000n; // 0.015 SOL: smaller round trips are fee-fodder
const MIN_ROUND_TRIP = 10_000_000n; // 0.01 SOL guardrail floor
const MAX_OPEN_POSITIONS = 5; // harness caps.max_open_positions
const BUY_SLIPPAGE = 800;
const SELL_SLIPPAGE = 1200;

const MIN_TRADES = 3; // entry needs at least this many trades
const MAX_MINT_AGE = 1800; // only mints created within ~12 minutes
const PRICE_WINDOW = 6; // recent prints kept per mint
const MIN_RISE_BPS = 1000; // peak must sit >= +10% above the first print
const MIN_PULLBACK_BPS = 400; // ...then the price must be >= 4% below peak

const TAKE_PROFIT_BPS = 1000; // +10% over entry price
const STOP_LOSS_BPS = -500; // -5% under entry price
const TRAIL_ARM_BPS = 500; // trailing stop arms at +5% peak gain
const TRAIL_FALL_BPS = 300; // sell on a 3% pullback from the peak
const MAX_HOLD = 300; // time stop in slots

// ------------------------------------------------------------------ env dirs

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ------------------------------------------------------------------ state

// What we remember about one mint: its price path since we first saw it.
interface CoinHistory {
  createdSlot: number | null;
  trades: number;
  prints: number[]; // recent prices, SOL per token, oldest first
  firstPrint: number; // first price ever seen (create price when available)
  peakPrint: number; // highest price seen so far
  finished: boolean; // a CompleteEvent arrived
}

// One open round trip we are managing.
interface OpenRoundTrip {
  mint: string;
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
  sizeLamports: bigint;
}

const histories = new Map<string, CoinHistory>();
const enteredOnce = new Set<string>(); // one buy per mint per run
const openTrips = new Map<string, OpenRoundTrip>();

let batchesHandled = 0;
let buysPlaced = 0;
let sellsPlaced = 0;
let tripsClosed = 0;

// ------------------------------------------------------------------ helpers

// SOL per token implied by a bonding curve's virtual reserves.
function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

// Gain of `now` versus `base`, in basis points (negative when below base).
function moveBps(now: number, base: number): number {
  if (!(base > 0)) return 0;
  return Math.round(((now - base) / base) * 10000);
}

function historyFor(mint: string): CoinHistory {
  const existing = histories.get(mint);
  if (existing !== undefined) return existing;
  const fresh: CoinHistory = {
    createdSlot: null,
    trades: 0,
    prints: [],
    firstPrint: 0,
    peakPrint: 0,
    finished: false,
  };
  histories.set(mint, fresh);
  return fresh;
}

function notePrint(h: CoinHistory, price: number): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  if (h.firstPrint === 0) h.firstPrint = price;
  if (price > h.peakPrint) h.peakPrint = price;
  h.prints.push(price);
  if (h.prints.length > PRICE_WINDOW) h.prints.shift();
}

// Is there an order for this mint still in flight?
function hasPendingOrder(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const pending of state.pending.values()) {
    if (pending.order.mint === mint && pending.order.side === side) return true;
  }
  return false;
}

// ------------------------------------------------------------------ observation

// Fold one batch's events into the per-mint histories. Only mints that
// actually appear in the batch are touched, so the work stays
// proportional to the events, not to every curve ever seen.
function observe(batch: Batch): void {
  for (const event of batch.events) {
    const h = historyFor(event.mint);
    if (event.event === 'CreateEvent') {
      h.createdSlot = event.slot;
      notePrint(h, curvePrice(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves)));
    } else if (event.event === 'TradeEvent') {
      h.trades += 1;
      notePrint(
        h,
        curvePrice(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves)),
      );
    } else {
      h.finished = true;
    }
  }
}

// ------------------------------------------------------------------ entry signal

// Is this mint a fresh momentum breakout worth one small buy?
function isEntry(state: BotState, mint: string, slot: number): boolean {
  if (enteredOnce.has(mint)) return false; // one buy per mint per run
  if (openTrips.has(mint)) return false;
  if (state.positions.has(mint)) return false;
  const h = histories.get(mint);
  if (h === undefined || h.finished) return false;
  if (h.trades < MIN_TRADES) return false;
  if (h.prints.length < 3) return false;
  if (h.createdSlot !== null && slot - h.createdSlot > MAX_MINT_AGE) return false;
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
  if (!(price > 0)) return false;
  // The coin first proved demand (peak >= 10% above its first print),
  // then gave some back (>= 4% below its peak), and the latest print is
  // bouncing (not below the print before it). Buying the dip after a
  // proven rise beats chasing the rise itself: the rise-chaser pays the
  // pumped price and sells into the dump that follows.
  if (moveBps(h.peakPrint, h.firstPrint) < MIN_RISE_BPS) return false;
  if (moveBps(price, h.peakPrint) > -MIN_PULLBACK_BPS) return false;
  if (h.prints.length >= 2 && price < h.prints[h.prints.length - 2]) return false;
  // The buy must be big enough to count as a round trip and small enough
  // to respect the harness cap (1% of the mint's real SOL reserve per
  // reply).
  const cap = state.maxBuyLamports(mint);
  const size = BUY_SIZE < cap ? BUY_SIZE : cap;
  if (size < MIN_BUY || size < MIN_ROUND_TRIP) return false;
  return true;
}

// ------------------------------------------------------------------ exit logic

type OrderOut =
  | { side: 'buy'; mint: string; quote_lamports: bigint; max_slippage_bps: number }
  | { side: 'sell'; mint: string; token_amount: bigint; max_slippage_bps: number };

// Decide the sells for this batch: every held position is checked
// against take-profit, hard stop, trailing stop and time stop, in that
// order. The first rule that fires sells the whole position.
function decideSells(state: BotState, batch: Batch): OrderOut[] {
  const sells: OrderOut[] = [];
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const trip = openTrips.get(mint);
    if (trip === undefined) continue; // a position with no tracked entry: leave it
    if (hasPendingOrder(state, mint, 'sell')) continue; // a sell is already in flight
    const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!(price > 0)) continue;
    if (price > trip.peakPrice) trip.peakPrice = price;
    const gain = moveBps(price, trip.entryPrice);
    const peakGain = moveBps(trip.peakPrice, trip.entryPrice);
    const trailing = peakGain >= TRAIL_ARM_BPS && moveBps(price, trip.peakPrice) <= -TRAIL_FALL_BPS;
    const stale = batch.slot - trip.entrySlot >= MAX_HOLD;
    if (gain >= TAKE_PROFIT_BPS || gain <= STOP_LOSS_BPS || trailing || stale) {
      // NOTE: the trip record is NOT deleted here. Cleanup in onBatch
      // drops it once the position is actually gone. A sell the harness
      // rejects leaves the position held, and the bot retries it on the
      // next batch instead of orphaning the slot forever.
      sells.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE });
      sellsPlaced += 1;
    }
  }
  return sells;
}

// ------------------------------------------------------------------ bot callbacks

async function onBatch(state: BotState, batch: Batch): Promise<OrderOut[]> {
  batchesHandled += 1;
  observe(batch);

  // Positions the harness flattened (curve completed / replay ended) are
  // gone from state.positions; drop their trip records too so nothing
  // goes stale — but only when no buy for that mint is still in flight,
  // so a pending buy's fill can still arrive and be tracked.
  for (const mint of [...openTrips.keys()]) {
    if (!state.positions.has(mint) && !hasPendingOrder(state, mint, 'buy')) {
      openTrips.delete(mint);
    }
  }

  const orders: OrderOut[] = [];
  orders.push(...decideSells(state, batch));

  // Entries: only from mints that traded in this batch, strongest rise
  // first, while a slot for a new position remains (max 5 open, counting
  // buys still in flight) and free cash covers the buy plus its tx fee.
  const room = MAX_OPEN_POSITIONS - state.committedPositionCount();
  if (room > 0) {
    const candidates: { mint: string; rise: number }[] = [];
    for (const event of batch.events) {
      if (event.event !== 'TradeEvent') continue;
      if (!isEntry(state, event.mint, batch.slot)) continue;
      const h = histories.get(event.mint);
      if (h === undefined) continue;
      let low = Infinity;
      for (const p of h.prints) if (p < low) low = p;
      const curve = state.curves.get(event.mint);
      if (curve === undefined) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      candidates.push({ mint: event.mint, rise: moveBps(price, low) });
    }
    candidates.sort((a, b) => b.rise - a.rise);
    const picked = new Set<string>();
    for (const candidate of candidates) {
      const buysThisReply = orders.filter((o) => o.side === 'buy').length;
      if (buysThisReply >= room) break;
      if (picked.has(candidate.mint)) continue;
      picked.add(candidate.mint);
      const cap = state.maxBuyLamports(candidate.mint);
      const size = BUY_SIZE < cap ? BUY_SIZE : cap;
      if (size < MIN_BUY) continue;
      // Reserve the cash for the orders already decided this batch as
      // well as this buy and its tx fee.
      let reserved = 0n;
      for (const o of orders) {
        reserved += state.txFeeLamports();
        if (o.side === 'buy') reserved += o.quote_lamports;
      }
      if (state.freeCashLamports() - reserved - size - state.txFeeLamports() < 0n) continue;
      const curve = state.curves.get(candidate.mint);
      if (curve === undefined) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (!(price > 0)) continue;
      orders.push({ side: 'buy', mint: candidate.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE });
      enteredOnce.add(candidate.mint);
      openTrips.set(candidate.mint, {
        mint: candidate.mint,
        entryPrice: price,
        peakPrice: price,
        entrySlot: batch.slot,
        sizeLamports: size,
      });
      buysPlaced += 1;
    }
  }

  // Count completed round trips from this batch's fills for the summary.
  for (const fill of batch.fills) {
    if (fill.status === 'filled' && fill.side === 'sell' && !fill.client_id.startsWith('_')) {
      tripsClosed += 1;
    }
  }
  return orders;
}

function onDone(state: BotState): void {
  // Best-effort run summary. The output directory is created if missing
  // and is NEVER deleted; a failure here must not fail the run, so it is
  // swallowed and reported on stderr instead.
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const summary = {
      bot: 'steady-ladder',
      batches: batchesHandled,
      buys_sent: buysPlaced,
      sells_sent: sellsPlaced,
      round_trips: tripsClosed,
      distinct_mints_bought: enteredOnce.size,
      final_cash_lamports: state.cash.toString(),
      open_positions: state.positions.size,
      input_dir: INPUT_DIR,
      output_dir: OUTPUT_DIR,
    };
    writeFileSync(join(OUTPUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(`summary write skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.error(
    `steady-ladder done: batches=${batchesHandled} buys=${buysPlaced} sells=${sellsPlaced} ` +
      `round_trips=${tripsClosed} mints=${enteredOnce.size} cash=${state.cash}`,
  );
}

await runBot({ onBatch, onDone });

// Keep the imported constant referenced so the import stays meaningful.
void LAMPORTS_PER_SOL;
