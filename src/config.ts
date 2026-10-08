function intEnv(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const v = Number(raw);
  if (v < min) throw new Error(`${name} must be >= ${min}`);
  return v;
}

export const PORT = intEnv("PORT", 8080);

/** Primary public LCD (load-balanced; does not echo x-cosmos-block-height). */
export const DEFAULT_PRIMARY_LCD = "https://terra-classic-lcd.publicnode.com";
/**
 * Backup LCDs, tried in this order after the primary. Both answered at-height
 * queries correctly in mainnet checks on 2026-10-07 and echo the served height in
 * `x-cosmos-block-height`, so a wrong-height answer is detected and failed over.
 * stakely also retains a much deeper block / tx history (lowest block ~28.1M).
 */
export const DEFAULT_BACKUP_LCDS = [
  "https://terraclassic-lcd-server-01.stakely.io",
  "https://lcd.terra-classic.hexxagon.io",
];

function normUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Ordered list of LCD upstreams.
 *  - `LCD_URLS` (comma separated) set: used verbatim, nothing appended.
 *  - otherwise: legacy single `LCD_URL` (or the public default) followed by
 *    DEFAULT_BACKUP_LCDS, de-duplicated. Existing deployments that only set
 *    `LCD_URL` therefore also get the backups.
 * Non-height reads are pinned to one upstream at a time (sticky fail-over in
 * this order, wrapping around); at-height reads are verified and may be
 * served by any upstream. Data is never mixed with tip state.
 */
export function resolveLcdUrls(env: Record<string, string | undefined>): string[] {
  if (env.LCD_URLS && env.LCD_URLS.trim()) return [...new Set(normUrls(env.LCD_URLS))];
  const primary = normUrls(env.LCD_URL || DEFAULT_PRIMARY_LCD);
  return [...new Set([...primary, ...DEFAULT_BACKUP_LCDS])];
}

export const LCD_URLS: string[] = resolveLcdUrls(process.env);

if (!LCD_URLS.length) throw new Error("No LCD upstream configured");

export const FACTORY =
  process.env.FACTORY ||
  "terra1veqa6znu8lfdmz9kp9v047chfmn84q5k3pacme75gl8ywmplk92q6xnq2k";

export const ROUTER =
  process.env.ROUTER ||
  "terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8";

export const DEX_KEY = process.env.DEX_KEY || "weso-defi";

export const PAIR_CACHE_TTL_MS = intEnv("PAIR_CACHE_TTL_MS", 300_000);
export const ASSET_CACHE_TTL_MS = intEnv("ASSET_CACHE_TTL_MS", 600_000);

/** Max number of blocks in one /events request (toBlock - fromBlock + 1). */
export const MAX_EVENTS_BLOCK_SPAN = intEnv("MAX_EVENTS_BLOCK_SPAN", 2000, 1);

/** Per-attempt HTTP timeout. */
export const HTTP_TIMEOUT_MS = intEnv("HTTP_TIMEOUT_MS", 20_000, 1);
/**
 * Attempts per upstream before failing over to the next upstream. Load-balanced
 * public LCDs mix backends with different state-pruning windows, so an
 * at-height query a few hours old can fail on one backend ("version does not
 * exist") and succeed on the next request; measured up to ~20% per-request
 * failure ~16k blocks back on publicnode, hence the generous default.
 */
export const UPSTREAM_ATTEMPTS = intEnv("UPSTREAM_ATTEMPTS", 8, 1);
/** Base backoff (ms); attempt n waits min(base * 2^(n-1), UPSTREAM_BACKOFF_MAX_MS). */
export const UPSTREAM_BACKOFF_MS = intEnv("UPSTREAM_BACKOFF_MS", 250);
export const UPSTREAM_BACKOFF_MAX_MS = intEnv("UPSTREAM_BACKOFF_MAX_MS", 2000);
/**
 * Re-reads of a block's at-height balances when they fail the reserve
 * invariant (state(h-1) + evented deltas == state(h)). Some load-balanced
 * public LCD backends intermittently ignore x-cosmos-block-height and answer
 * HTTP 200 with tip state (observed on publicnode 2026-10-05); the invariant
 * detects that, and fresh reads usually land on a correct backend. If it still
 * fails after these attempts the request returns 503.
 */
/**
 * Before searching a range, the tx index is probed this many times at the
 * first block >= fromBlock that has txs: the node's tx index can be pruned
 * higher than its block store (observed: block 30522054 retained, its tx not
 * searchable), and behind a load balancer each probe may hit another backend.
 */
export const TX_INDEX_PROBES = intEnv("TX_INDEX_PROBES", 3, 1);
export const RESERVE_CONSISTENCY_ATTEMPTS = intEnv("RESERVE_CONSISTENCY_ATTEMPTS", 4, 1);

/**
 * Safety lag for /latest-block: min(tip samples across all upstreams) - LAG.
 * Tendermint has instant finality; the lag only covers load-balanced nodes that
 * are a few blocks behind each other and tx-index commit latency.
 */
export const LATEST_BLOCK_LAG = intEnv("LATEST_BLOCK_LAG", 5);
export const LATEST_BLOCK_SAMPLES = intEnv("LATEST_BLOCK_SAMPLES", 3, 1);
/**
 * An upstream whose tip is more than this many blocks behind the highest tip
 * seen is treated as stale: ignored by /latest-block (so one stuck node cannot
 * freeze indexing) and never used to serve /events tx searches.
 */
export const UPSTREAM_MAX_TIP_LAG = intEnv("UPSTREAM_MAX_TIP_LAG", 30);

/** Max parallel upstream requests per /events call. */
export const UPSTREAM_CONCURRENCY = intEnv("UPSTREAM_CONCURRENCY", 6, 1);

/** Tx search page size (LCD max is 100). */
export const TX_SEARCH_PAGE_SIZE = 100;

/**
 * Factory pair types that are not trading pools: token_bonding = LUNC<->CWLUNC /
 * USTC<->CWUSTC wrap vaults, converter = converter contract. Same exclusions as
 * the DefiLlama WESO adapter.
 */
export const EXCLUDED_PAIR_TYPES = new Set(["token_bonding", "converter"]);

export const CWLUNC =
  "terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6";
export const CWUSTC =
  "terra1uncwzdhxdktqpx4rj6mkuhl0ekv0raua0058rr7zgnapm9najyyqgtpf6h";

/** Product cw20_bonding curves (the curve contract is also the CW20 token). */
export const WESO_CURVE =
  "terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms";
export const REBASE_CURVE = "terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m";

export interface BondingCurveDef {
  id: string;
  /** Native reserve denom (asset0). The curve token itself is asset1. */
  reserveDenom: string;
}

export const BONDING_CURVES: BondingCurveDef[] = [
  { id: WESO_CURVE, reserveDenom: "uluna" },
  { id: REBASE_CURVE, reserveDenom: "uusd" },
];

export const BONDING_CURVE_IDS = new Set(BONDING_CURVES.map((c) => c.id));

/** Native denoms on Terra Classic (columbus-5). */
export const NATIVE_ASSETS: Record<
  string,
  { name: string; symbol: string; decimals: number; coinGeckoId: string }
> = {
  uluna: { name: "Luna Classic", symbol: "LUNC", decimals: 6, coinGeckoId: "terra-luna" },
  uusd: { name: "TerraClassicUSD", symbol: "USTC", decimals: 6, coinGeckoId: "terrausd" },
};
