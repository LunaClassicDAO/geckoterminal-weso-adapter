# WESO DeFi — GeckoTerminal Adapter API (Terra Classic)

HTTP API implementing the GeckoTerminal Integration API Standards (Non-EVM partner adapter) for **WESO DeFi** on
**Terra Classic (columbus-5)**.

| | |
| --- | --- |
| Base URL | `https://geckoterminal-weso-adapter.vercel.app` |
| GeckoTerminal network id | `terra` |
| `dexKey` | `weso-defi` |
| Adapter documentation | [`docs/ADAPTER.md`](./docs/ADAPTER.md) (served at `/docs/ADAPTER.md`) |

Scope: factory AMM pairs (`reflective`, `cumulative`) + the two product bonding curves ($WESO vs LUNC, $reBASE vs
USTC). Wrap vaults (`token_bonding`), the `converter` and forex CLOB fills are out of scope.

## Contracts

| Role | Address |
| --- | --- |
| Factory | `terra1veqa6znu8lfdmz9kp9v047chfmn84q5k3pacme75gl8ywmplk92q6xnq2k` |
| Router | `terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8` |
| $WESO curve | `terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms` |
| $reBASE curve | `terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m` |

## Repository layout

The app lives at the repository root (there is no `adapter-api/` subfolder):

```
src/config.ts     env + constants
src/upstream.ts   LCD client: retries, backoff, sticky fail-over, paginated tx search
src/parse.ts      pure tx -> GT event parsing + balance deltas (unit tested on real txs)
src/events.ts     /events + /latest-block orchestration (txnIndex, reserves at height)
src/pairs.ts      factory pairs + bonding curves (feeBps from chain)
src/assets.ts     /asset (token_info verbatim; natives static)
src/index.ts      Express app (also the Vercel entry via api/index.ts)
test/             node:test suites + recorded mainnet fixtures
scripts/          smoke test, fixture recorder
docs/ADAPTER.md   GT-facing documentation
```

## Run locally

```bash
npm ci
npm start            # listens on :8080 (PORT to override)
```

Checks:

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit + replay tests (offline, recorded mainnet fixtures)
npm run smoke        # live smoke test against a running server (BASE_URL, default http://localhost:8080)
```

`npm run smoke` finds a recent block range that actually contains events (scanning back up to ~26 h from
`/latest-block`), validates every event against the GT schema rules, checks `/pair` and `/asset` for every
referenced id, and repeats the range to confirm byte-identical output.

`npx tsx scripts/record-fixtures.ts` re-records the replay fixtures from mainnet (review the diff of
`test/fixtures/expected/` before committing).

### Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `LCD_URLS` | `https://terra-classic-lcd.publicnode.com` | Comma-separated LCD upstreams, ordered fail-over (falls back to legacy `LCD_URL`) |
| `FACTORY` / `ROUTER` | see table | Override only for forks/tests |
| `DEX_KEY` | `weso-defi` | Pair `dexKey` |
| `MAX_EVENTS_BLOCK_SPAN` | `2000` | Max blocks per `/events` call (`toBlock - fromBlock + 1`) |
| `LATEST_BLOCK_LAG` | `5` | `/latest-block` = min tip across upstreams − lag |
| `LATEST_BLOCK_SAMPLES` | `3` | Tip samples per upstream |
| `HTTP_TIMEOUT_MS` | `20000` | Per-attempt upstream timeout |
| `UPSTREAM_ATTEMPTS` | `8` | Attempts per upstream (exponential backoff) before fail-over |
| `UPSTREAM_BACKOFF_MS` | `250` | Base backoff |
| `UPSTREAM_BACKOFF_MAX_MS` | `2000` | Backoff cap per attempt |
| `RESERVE_CONSISTENCY_ATTEMPTS` | `4` | Re-reads of a block's at-height balances when the reserve invariant fails (then 503) |
| `UPSTREAM_CONCURRENCY` | `6` | Parallel upstream calls per `/events` request |
| `PAIR_CACHE_TTL_MS` / `ASSET_CACHE_TTL_MS` | `300000` / `600000` | Metadata caches |

## Endpoints

| Endpoint | Notes |
| --- | --- |
| `GET /latest-block` | lagged, finalized height every upstream has indexed |
| `GET /asset?id=` | `uluna`, `uusd`, or a CW20 contract that belongs to a listed pair; anything else 404 |
| `GET /pair?id=` | factory pair or curve contract; wrap vaults/converter 404 |
| `GET /events?fromBlock=&toBlock=` | inclusive, ≤ 2000 blocks; strict validation; 5xx on any upstream problem |
| `GET /pairs`, `GET /health` | ops helpers (not part of the GT spec) |

Event semantics (amounts, fees, reserves, `txnIndex` / `eventIndex` / `maker`) and the full error table are in
[`docs/ADAPTER.md`](./docs/ADAPTER.md).

## Known limitations

1. **Retained history.** The default public LCD keeps a limited block/tx history (lowest ≈ block 30.52M on
   2026-10-05). Ranges below it return 503 `height_not_available`. Add an archive LCD to `LCD_URLS` for backfill.
2. **Several events of one pair in a single tx** (never observed in retained history) return 503: intermediate
   reserves are not observable on-chain, and the adapter will not guess.
3. **Unexplained balance changes.** If a pool balance changes in a block without matching events (for example a
   wrap-vault mint straight into a pair), the request returns 503 rather than reporting unverified reserves.
4. **cwLUNC USD price.** cwLUNC has no CoinGecko id; the adapter does not invent one (see docs).
5. **Curve asset1 reserve is 0** by design (no pooled curve tokens; see docs).

Phase 2 (deferred): forex orderbook fills from `https://weso.world/api/orderbook-fills`.

Do **not** submit the GeckoTerminal form from this repo.
