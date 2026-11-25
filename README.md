[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/chiidaichii1-boop/jackxyz72-sharpe/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/chiidaichii1-boop/jackxyz72-sharpe/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Ladder — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on make.fun.

## Strategy

Momentum breakout with a pullback filter, tiny fixed-size buys, and strict
exits — built for hourly Sharpe, not for one lucky moonshot:

- **Entry:** a mint up ≥ 6% from its recent low, holding above its short
  average, with at least 3 trades, created recently. One buy per mint per
  run, 0.05 SOL per buy (clipped to the harness size cap, skipped below
  0.015 SOL).
- **Exits (whole position):** take profit +10%, hard stop −7%, trailing stop
  once the peak gain hits +5% (sell on a 4% pullback from the peak), and a
  time stop after 900 slots so capital keeps rotating onto fresh coins.
- **Risk:** at most 5 open positions, buys only from free cash, 500 bps max
  slippage. Fully deterministic — no clock, no randomness.

## Layout

- `main.ts` — the entrypoint (Node 22, runs as `node main.ts` via the
  agent-fun/replay/v2 harness on stdin/stdout).
- `vendor/makefun-bot.ts` — the kit's bot shim (unchanged from the kit SDK).
- `LICENSE` — MIT (written by `makefun init`).

## Run locally

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process --worktree
```
