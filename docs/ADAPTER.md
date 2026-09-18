# WESO DeFi Network Adapter Documentation  
### GeckoTerminal Non-EVM Partner API — Terra Classic (columbus-5)

**DEX / product:** WESO DeFi  
**Website:** https://weso.world  
**Chain:** Terra Classic (`columbus-5`)  
**dexKey:** `weso-defi`

This document describes the Network Adapter HTTP API used to index WESO DeFi on GeckoTerminal: **factory AMM** pools **and** product **cw20 bonding curves** ($WESO, $reBASE). It follows the GeckoTerminal Integration API Standards (Latest Block, Asset, Pair, Events).

---

## 1. Contracts

| Role | Address |
| --- | --- |
| AMM Factory | `terra1veqa6znu8lfdmz9kp9v047chfmn84q5k3pacme75gl8ywmplk92q6xnq2k` |
| AMM Router | `terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8` |
| $WESO bonding curve (CW20 vs LUNC) | `terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms` |
| $reBASE bonding curve (CW20 vs USTC) | `terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m` |

### Included pairs

**Factory AMM** (aligned with DeFiLlama AMM volume methodology):

- `reflective`
- `cumulative`

**Product bonding curves** (first-class pairs in v1 — project is built on bonding curves):

| Pair id (= curve contract) | asset0Id | asset1Id | name |
| --- | --- | --- | --- |
| $WESO curve | `uluna` | WESO contract | `LUNC/WESO` |
| $reBASE curve | `uusd` | reBASE contract | `USTC/reBASE` |

Metadata on curve pairs: `{ pairType: "cw20_bonding", bondingCurve: "true" }`.  
`feeBps`: curve wasm `commission_amount` is `0`; documented default **`0`**. (A separate project tax ~1% appears as `tax_amount` on events and is **not** mapped into `feeBps`.)

### Excluded (not DEX product pairs)

Factory pair types:

- `token_bonding` — native ↔ CW20 **wrap vaults** (LUNC↔CWLUNC, USTC↔CWUSTC plumbing). These are **not** the $WESO / $reBASE product curves.
- `converter`

Wrap vault contracts must **404** when used as `/pair?id=`.

### Deferred (Phase 2)

- Forex CLOB taker fills

---

## 2. Base URL

```
https://weso.world/api/gt
```

All paths below are relative to that API base (e.g. `GET https://weso.world/api/gt/latest-block`).

**Stable docs URLs:**
- Hosted: `https://weso.world/api/gt/docs/ADAPTER.md`
- GitHub raw (always available): `https://raw.githubusercontent.com/LunaClassicDAO/geckoterminal-weso-adapter/main/docs/ADAPTER.md`

Production base URL is **`https://weso.world/api/gt`** (hosted on the WESO DeFi DEX Next.js app). Do **not** use wesoenergy.com. Product website for the listing form is `https://weso.world`.

---

## 3. Endpoints

### 3.1 `GET /latest-block`

Returns the latest Terra Classic block the adapter can serve via `/events` (LCD tip; events are queried on-demand).

**Response**

```json
{
  "block": {
    "blockNumber": 30447625,
    "blockTimestamp": 1726617120
  }
}
```

- `blockTimestamp` is Unix seconds (not ms).

### 3.2 `GET /asset?id={assetId}`

**Asset ID rules**

| Kind | `id` | Example |
| --- | --- | --- |
| Native LUNC | `uluna` | Luna Classic / LUNC / 6 decimals |
| Native USTC | `uusd` | TerraClassicUSD / USTC / 6 decimals |
| CW20 (wraps + curves + other) | contract address | CWLUNC, CWUSTC, WESO, reBASE |

**Notable CW20 assets**

| Symbol | Decimals | Contract |
| --- | --- | --- |
| CWLUNC | 6 | `terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6` |
| CWUSTC | 6 | `terra1uncwzdhxdktqpx4rj6mkuhl0ekv0raua0058rr7zgnapm9najyyqgtpf6h` |
| WESO | 6 | `terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms` |
| reBASE | 6 | `terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m` |

Symbols/names/decimals come from `token_info` with config overrides. Amounts elsewhere are **decimalized** (`raw / 10^decimals`).

### 3.3 `GET /pair?id={pairId}`

`pairId` is either:

- a **factory AMM pair** contract address, or
- a **product bonding-curve** contract address ($WESO / $reBASE)

- `dexKey` is always `weso-defi`
- AMM: `asset0Id` / `asset1Id` follow on-chain `asset_infos[0]` / `[1]`
- Curves: `asset0Id` = reserve denom (`uluna` / `uusd`); `asset1Id` = the CW20 curve contract (same as pair id)
- `name` is non-empty (`SYMBOL0/SYMBOL1`)
- AMM `feeBps` from `commission_rate` (typically `20`); curves use documented `0`

### 3.4 `GET /events?fromBlock={n}&toBlock={n}`

Inclusive height range. Returns swap events (and join/exit when liquidity attrs are available) for **included** factory AMM pairs **and** both product bonding curves.

**Swap fields**

- Exactly one of (`asset0In`+`asset1Out`) or (`asset1In`+`asset0Out`)
- `priceNative` = price of **asset0 quoted in asset1** (never `0`)
- `reserves.asset0` / `reserves.asset1` after the swap

**Bonding-curve buy/sell mapping** (mirrors DeFiLlama WESO curve volume logic):

| On-chain | GT fields |
| --- | --- |
| Buy (native paid into curve → CW20 minted) | `asset0In` (uluna/uusd) + `asset1Out` (CW20) |
| Sell / burn (CW20 in → native out to trader) | `asset1In` (CW20) + `asset0Out` (native) |

Wasm attrs on the curve contract: `action=swap` with `offer_asset` / `ask_asset` / `offer_amount` / `return_amount`. Non-swap transfers (flywheel, `pay_miners`, plain `transfer`) are excluded.

**Reserves for curves:** prefer amounts implied by the swap when present; else `curve_info.reserve` → `reserve0` (native) and `curve_info.supply` → `reserve1` (circulating CW20), so `priceNative` is never `0`.

**Event discovery:** Terra Classic LCD tx search  
`tx.height>=fromBlock AND tx.height<=toBlock AND wasm._contract_address='<pair|curve>'`,  
parsing CosmWasm `wasm` attributes with `action=swap`.

---

## 4. Alignment with DeFiLlama WESO volume

| Llama volume source | In this GT adapter? |
| --- | --- |
| Factory AMM (`reflective` / `cumulative`) | **Yes** |
| $WESO bonding-curve LUNC volume | **Yes** (pair = WESO curve) |
| $reBASE bonding-curve USTC volume | **Yes** (pair = reBASE curve; Llama currently emphasizes WESO LUNC — both product curves are in GT v1) |
| Forex CLOB LUNC quote taker fills | Phase 2 / deferred |
| Wrap/unwrap & converter | **Excluded** (same as Llama) |

---

## 5. Operational notes for GeckoTerminal Indexer

- Poll `/latest-block`, then `/events?fromBlock&toBlock` in chunks (recommended ≤ 500–2000 blocks depending on activity).
- Invalid schemas that halt indexing are avoided: no empty `pair.name`, no `priceNative=0`, decimalized amounts, stable asset0/asset1 order.
- Upstream LCD: `https://terra-classic-lcd.publicnode.com` (configurable).

---

## 6. Contact

- Email: dao@lunaclassicdao.com  
- Telegram: https://t.me/ClassicDAO  
- X: @daolunaclassic  

---

*Document version: 1.1 — factory AMM + product bonding curves ($WESO, $reBASE) for GeckoTerminal listing.*
