# WESO DeFi Network Adapter Documentation
### GeckoTerminal Non-EVM Partner API — Terra Classic (columbus-5)

| | |
| --- | --- |
| **Base URL** | `https://geckoterminal-weso-adapter.vercel.app` |
| **GeckoTerminal network id** | `terra` |
| **dexKey** | `weso-defi` |
| **Chain** | Terra Classic (`columbus-5`) |
| **DEX / product** | WESO DeFi (website: https://weso.world — website only, the API is not served from it) |
| **Spec followed** | GeckoTerminal Integration API Standards v0.1 (Latest Block, Asset, Pair, Events) |

All endpoint paths below are relative to the base URL, e.g.
`GET https://geckoterminal-weso-adapter.vercel.app/latest-block`.

Stable copy of this document: `https://raw.githubusercontent.com/LunaClassicDAO/geckoterminal-weso-adapter/main/docs/ADAPTER.md`
(also served at `https://geckoterminal-weso-adapter.vercel.app/docs/ADAPTER.md`).

---

## 1. Contracts and pairs

| Role | Address |
| --- | --- |
| AMM factory | `terra1veqa6znu8lfdmz9kp9v047chfmn84q5k3pacme75gl8ywmplk92q6xnq2k` |
| AMM router | `terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8` |
| $WESO bonding curve (CW20 vs LUNC) | `terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms` |
| $reBASE bonding curve (CW20 vs USTC) | `terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m` |

**Included**

- Factory pairs whose `pair_type` is `reflective` or `cumulative` (asset order = on-chain `asset_infos[0]` / `[1]`).
- The two product bonding curves. Pair id = curve contract; `asset0Id` = reserve denom (`uluna` / `uusd`), `asset1Id` = the curve's CW20 (same address as the pair).

**Excluded** (not trading pools; `/pair?id=` returns 404): factory `token_bonding` wrap vaults (LUNC↔cwLUNC, USTC↔cwUSTC, 1:1 plumbing) and the `converter`. Same exclusions as the DefiLlama WESO adapter. Forex CLOB fills are not included.

---

## 2. Endpoints

### 2.1 `GET /latest-block`

```json
{ "block": { "blockNumber": 30710783, "blockTimestamp": 1791250626 } }
```

`blockNumber` = (minimum of 3 tip samples on every reachable LCD upstream whose tip is within
`UPSTREAM_MAX_TIP_LAG` = 30 blocks of the best one) − 5. Tendermint has instant
finality; the 5-block lag only absorbs load-balanced nodes that are a block or two apart and tx-index commit
latency, so every height this endpoint returns is fully available to `/events` (spec: "it should not return a
block for which /events has no data available yet"). `blockTimestamp` is that block's header time in Unix
seconds. If no upstream answers the request returns 5xx (never a guessed height); a single unreachable or stuck
backup is ignored.

### 2.2 `GET /asset?id={assetId}`

| Kind | `id` | Source |
| --- | --- | --- |
| Native LUNC | `uluna` | static: `Luna Classic` / `LUNC` / 6 / `coinGeckoId: terra-luna` |
| Native USTC | `uusd` | static: `TerraClassicUSD` / `USTC` / 6 / `coinGeckoId: terrausd` |
| CW20 | contract address | `token_info` verbatim (name, symbol, decimals, total_supply) |

Only assets that belong to a listed pair are served; anything else (including `ibc/…` denoms) is a 404.
Examples: cwLUNC `terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6` → name `LUNC (cw20)`,
symbol `cwLUNC`; WESO → `WESO`.

> **USD pricing note.** All factory pairs quote in cwLUNC, which has no CoinGecko id. cwLUNC is minted 1:1
> against LUNC by the wrap vault, but the GT spec only describes `coinGeckoId` as a source of display
> information (image, description, circulating supply), not as a peg, so the adapter does **not** map cwLUNC
> to `terra-luna`. USD values for the factory pairs therefore depend on how GeckoTerminal prices cwLUNC.

### 2.3 `GET /pair?id={pairId}`

- `dexKey` = `weso-defi`; non-empty `name` = `SYMBOL0/SYMBOL1` from on-chain symbols (e.g. `JURIS/cwLUNC`, `LUNC/WESO`).
- AMM `feeBps` = on-chain `config.commission_rate` × 10 000 (exact decimal; e.g. 0.002 → 20, 0.01 → 100).
- Curve `feeBps` = on-chain `param_info.project_tax_pct` (per-mille) × 10 → currently 10‰ = **100**. The
  effective per-swap tax varies by tax zone (observed: ~0.99% on buys, 0–0.16% on sells); the exact amount of
  every swap is reported in the event's `feesIn`/`feesOut`.

### 2.4 `GET /events?fromBlock={n}&toBlock={n}`

Both bounds inclusive, at most **2000 blocks** per request (`toBlock − fromBlock + 1 ≤ 2000`).

**Request validation / errors** — every error is JSON `{ "error", "code", … }` and never contains upstream URLs:

| Situation | Status | `code` |
| --- | --- | --- |
| Param missing, repeated, not a plain non-negative integer, `fromBlock < 1`, `fromBlock > toBlock` | 400 | `invalid_params` |
| More than 2000 blocks | 400 | `range_too_large` |
| `toBlock` above the lagged height `/latest-block` would return now (upstream tip − `LATEST_BLOCK_LAG`) | 400 | `range_not_available` (+ `latestBlock`) |
| `fromBlock` below the oldest block (or oldest indexed tx / state) retained by every upstream node | 503 | `height_not_available` (+ `lowestAvailableBlock` = lowest block any upstream retains, when every node reports it; hint only — the tx index may start slightly higher) |
| Upstream node unreachable / 5xx / 429 after retries and fail-over | 502 | `upstream_unavailable` |
| Every upstream rejects the request with a 4xx (misconfigured / incompatible node) | 502 | `upstream_bad_response` |
| Upstream returned inconsistent data (tx-search totals, block contents, every node answering at-height queries from another height) | 503 | `upstream_inconsistent` |
| Pool balance change in a block not fully explained by events | 503 | `reserve_reconstruction_failed` |

An empty `{"events": []}` is only ever returned for a valid, fully available range that genuinely contains no
events. Responses for a fixed range are byte-for-byte deterministic.

**How events are built**

1. Tx discovery: LCD tx search `tx.height>=from AND tx.height<=to AND wasm._contract_address='<pair>'` per
   pair, walking **every** page in ascending order and verifying the collected count against `total`.
2. For every block that contains events: the block itself (`/cosmos/base/tendermint/v1beta1/blocks/{h}`) and
   all of its tx results (`tx.height=h`) are loaded and must match one-to-one.
3. `txnIndex` = the tx's position in the block (`sha256` of the raw tx bytes in `block.data.txs`).
4. `eventIndex` = the event's position inside the tx (each non-wasm event counts 1, each contract section of a
   wasm event counts 1), so it is unique within the tx across all pairs and increases with execution order.
5. `maker` = the signer of the message that produced the event (`messages[msg_index].sender`, inner sender for
   authz `MsgExec`). Router-routed swaps report the trader, not the router.
6. Reserves (see below) are read **at the event's block height**; there is no fallback to current state.
   At-height queries are retried with exponential backoff and fail over to the next upstream on errors, empty
   answers, or an echoed `x-cosmos-block-height` that differs from the requested height (stakely / hexxagon
   echo it); if they still fail the whole request returns 5xx so GeckoTerminal retries the range. Tx search
   and block reads are pinned to one upstream and only fail over to an upstream whose own tip covers the range.

**Swap amounts** (spec Scenarios A/B: `assetIn` = what the pool receives from the user, `assetOut` = curve
output, fees in `metadata.feesIn` / `feesOut`):

| Pair / direction | assetIn | assetOut | fees |
| --- | --- | --- | --- |
| AMM | `offer_amount` | `return_amount + commission + tax_amount + chancla_tax_amount` (== `vg` on reflective pairs) | `feesOut` = `commission + tax_amount + chancla_tax_amount` |
| Curve buy (native → CW20) | `asset0In` = `offer_amount` (native sent) | `asset1Out` = `return_amount` (minted) | `fees0In` = `tax_amount` |
| Curve sell / burn (CW20 → native) | `asset1In` = `offer_amount` (burned) | `asset0Out` = `return_amount + tax_amount` (native released) | `fees0Out` = `tax_amount` |

Curve tax handling: on buys the curve receives `offer_amount` and pays `tax_amount` out again (to tax
recipient contracts, or back to the trader's own address, depending on the swap); on sells it releases
`return_amount + tax_amount` to the seller. `tax_amount` is the project tax (`param_info.project_tax_pct`, 1% →
`feeBps` 100). Terra Classic's chain burn tax on those bank transfers is a chain-level levy and is not reported as
a DEX fee. A buy can additionally forward part of the curve's native reserve to a DAO DAO treasury contract
(`terra17x9tpp…`) in the same tx (observed, e.g. tx `B17D2BFB…`); that forward is not charged to the trader, so it is not in the
event amounts — it only shows up as a lower `asset0` reserve, which is read from the real bank balance.

`priceNative` = asset1 per asset0 using the amounts that went through the curve math (input after `feesIn`,
output before `feesOut`), computed with exact integer arithmetic and truncated to 50 decimals. A swap that moves
zero of either asset cannot be priced (GT halts on `priceNative = 0`) and is omitted; its balance effect is
contained in the next event's reserves.

**Join / exit** (factory pairs): TerraSwap-style attributes, e.g.
`assets = "106465604543terra19ya4…, 36728932099terra10fusc…"`. Join amounts = `assets − refund_assets`; exit
amounts = `refund_assets` (paid out).

**Reserves** ("pooled amount of each asset after the event"):

- Factory pairs: the pair contract's CW20 (or bank) balances of asset0/asset1, which equal `pool {}`. Read after
  the **full** tx, i.e. after the reflective pairs' vault hydration / rebalance payouts.
- Curves: `asset0` = the curve contract's native bank balance. `asset1` = `0`: the curve mints tokens to buyers
  and burns them from sellers; it holds no pooled inventory of its own token that trades are filled from (its
  `curve_info.supply` is circulating supply, not liquidity). Reporting 0 means liquidity equals the native
  backing only and is never inflated.
- If the event's tx is the last tx of the block that touches the pair, reserves = balances at height h. If later
  txs in the same block touch the pair, their exact balance deltas (bank `coin_received`/`coin_spent`, CW20
  `transfer`/`send`/`transfer_from`/`send_from`/`burn`/`burn_from`/`mint`) are subtracted. Every block is
  checked: balances(h−1) + all evented deltas == balances(h). A mismatch is re-read a few times, each time on
  the next upstream (some public LCD backends intermittently ignore `x-cosmos-block-height` and answer with
  tip or stale state — the check catches that); if it still fails, the request fails (503) rather than
  reporting unverified reserves.
- Several events of one pair in **one tx** (not observed in retained history, e.g. two swaps signed in one
  tx): the state before the tx (= state after the tx minus its exact deltas) is the starting point and the
  tx's balance deltas are applied in event-position order. The boundary between event k−1 and event k is
  event k's trigger — its swap offer / native join deposit arriving at the pool, recorded just before the
  pair's wasm section — or event k's own position when no trigger is visible (CW20 join deposits are pulled
  after the section). Outputs, fees and payouts of event k−1 therefore stay with event k−1. The last event of
  the tx equals the state after the tx, which the block check above verifies.

---

## 3. Operational notes for the GeckoTerminal indexer

- Poll `/latest-block`, then call `/events` with chunks of ≤ 2000 blocks.
- Public LCDs retain a limited block/tx history (publicnode ≈ 30.52M, stakely ≈ 28.1M as of 2026-10-07; state
  for reserves may be pruned higher). A range is served by the first upstream that retains it; below every
  upstream's history requests return 503 `height_not_available`. Deeper backfill needs an archive LCD in
  `LCD_URLS`.
- Upstreams: `LCD_URLS` (comma-separated, ordered fail-over, used verbatim). Default:
  `https://terra-classic-lcd.publicnode.com`, then the backups `https://terraclassic-lcd-server-01.stakely.io`
  and `https://lcd.terra-classic.hexxagon.io`. A legacy single `LCD_URL` is followed by the same backups.

---

## 4. Contact

- Email: dao@lunaclassicdao.com
- Telegram: https://t.me/ClassicDAO
- X: @daolunaclassic

*Document version 2.1 — per-event reserves for several events in one tx, backup LCDs with verified fail-over,
retained-history hints. (2.0: spec-conformance fixes — historical reserves, txnIndex/eventIndex, maker, fees,
errors.)*
