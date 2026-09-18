# WESO DeFi — GeckoTerminal Adapter API (Terra Classic)

HTTP API implementing [GeckoTerminal Non-EVM / partner adapter](https://docs.google.com/document/d/1ufjAJUa6rGO9PBGJGwfBMn-XMk9NE0ow3_iMYrS3drk/edit) endpoints for **WESO DeFi** on **Terra Classic (columbus-5)**.

**Scope (v1):** factory AMM pairs **+** product bonding curves (`$WESO`, `$reBASE`). Wrap vaults and forex CLOB are out of scope.

Public network-adapter write-up for the GT listing form: [`docs/ADAPTER.md`](./docs/ADAPTER.md).

## Contracts

| Role | Address |
| --- | --- |
| Factory | `terra1veqa6znu8lfdmz9kp9v047chfmn84q5k3pacme75gl8ywmplk92q6xnq2k` |
| Router | `terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8` |
| $WESO curve | `terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms` |
| $reBASE curve | `terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m` |
| `dexKey` | `weso-defi` |

## Methodology vs DeFiLlama

DeFiLlama’s WESO volume adapter counts:

1. **Factory AMM swaps** (pair types `reflective` + `cumulative`) via on-chain `volume_buckets`
2. **$WESO bonding-curve** buy/sell as native LUNC (separate contract, not a factory pair)
3. **Forex CLOB** taker fills on the LUNC quote side

It **excludes** wrap/unwrap (`token_bonding`) and `converter` factory pair types.

This GT adapter implements **(1) and (2)** for pair charts, and also indexes **$reBASE** (USTC bonding curve) the same way — both product curves are first-class pairs:

- Lists factory pairs whose `pair_type` is **not** `token_bonding` or `converter`
- Lists `$WESO` and `$reBASE` curve contracts as pairs (`asset0` = native reserve denom, `asset1` = CW20 curve)
- Emits `swap` for AMM + curve buy/sell (join/exit on AMM when LP attrs exist)
- Asset IDs: native denoms `uluna` / `uusd`; CW20s (CWLUNC / CWUSTC / WESO / reBASE) use **contract addresses**
- **Does not** treat wrap vaults as pairs (404 on those contract ids as `/pair`)

**(3) Forex CLOB** remains **Phase 2 / deferred**.

### Bonding-curve swap mapping

| Trade | GT fields |
| --- | --- |
| Buy (native → mint CW20) | `asset0In` + `asset1Out` |
| Sell/burn (CW20 → native out) | `asset1In` + `asset0Out` |

Reserves: `curve_info.reserve` / `curve_info.supply` when not on the event. `priceNative` never `0`.

## Run locally

```bash
cd adapter-api
npm install
npm start
# listens on :8080 by default
```

Smoke test (server must be running):

```bash
npm run smoke
```

### Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `LCD_URL` | `https://terra-classic-lcd.publicnode.com` | CosmWasm + Tendermint REST |
| `FCD_URL` | `https://terra-classic-fcd.publicnode.com` | Optional fallback tooling |
| `FACTORY` / `ROUTER` | (see table) | Override only for forks/tests |
| `DEX_KEY` | `weso-defi` | Pair `dexKey` |
| `PAIR_CACHE_TTL_MS` | `300000` | Factory + curve pair list cache |
| `ASSET_CACHE_TTL_MS` | `600000` | Asset metadata cache |
| `MAX_EVENTS_BLOCK_SPAN` | `2000` | Max `toBlock-fromBlock` per `/events` call |
| `HTTP_TIMEOUT_MS` | `45000` | Upstream LCD timeout |

## Endpoints

### `GET /latest-block`

```json
{ "block": { "blockNumber": 30447625, "blockTimestamp": 1726617120 } }
```

Synced to LCD `/cosmos/base/tendermint/v1beta1/blocks/latest`. Events are fetched on-demand from LCD, so this tip is always servable by `/events`.

### `GET /asset?id=`

Examples: `uluna`, `uusd`, WESO/reBASE/CWLUNC/CWUSTC CW20 addresses.

### `GET /pair?id=`

`id` = AMM pair contract **or** product bonding-curve contract. Preserves stable `asset0Id` / `asset1Id`. Non-empty `name` and `feeBps`.

### `GET /events?fromBlock=&toBlock=`

Inclusive height range. Sources txs via LCD:

`tx.height>=from AND tx.height<=to AND wasm._contract_address='<pair|curve>'`

Parses wasm `action=swap` (AMM + curves). Prefer on-event reserves; else pool / `curve_info` query.

### `GET /health` / `GET /pairs`

Ops helpers (not required by GT). `/health` `pairCount` includes AMM + both curves.

## Limitations / gaps vs full historical GT indexing

1. **No persistent indexer DB** — each `/events` call hits LCD. Large spans or many pairs can be slow; keep GT chunk size ≤ `MAX_EVENTS_BLOCK_SPAN`.
2. **Historical reserves** — public LCD often returns current pool/`curve_info` state even with `?height=`. When swap events include `reserve0`/`reserve1` (WESO reflective `managed_swap_finalized`), those are used. Otherwise reserves may be tip-approximate for older heights.
3. **Pagination** — LCD search is capped (`pagination.limit=100`). Extremely busy windows may need smaller height chunks.
4. **Join/exit** — emitted only when provide/withdraw wasm attrs include amounts; swaps alone carry post-trade reserves. Bonding curves do not emit join/exit.
5. **Phase 2 not in `/events`:** forex CLOB (counted by Llama, separate from AMM + curves).

## Phase 2 (deferred)

- Forex orderbook fills from `https://weso.world/api/orderbook-fills` as additional pairs

Do **not** submit the Google Form from this repo; publish `docs/ADAPTER.md` first, then fill the form manually.
