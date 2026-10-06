function intEnv(name: string, def: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const v = Number(raw);
  if (v < min) throw new Error(`${name} must be >= ${min}`);
  return v;
}

export const PORT = intEnv("PORT", 8080);

/**
 * Ordered list of LCD upstreams. `LCD_URLS` (comma separated) wins over the
 * legacy single `LCD_URL`. Every request is pinned to one upstream at a time
 * (sticky fail-over in this order); data is never mixed with tip state.
 */
export const LCD_URLS: string[] = (
  process.env.LCD_URLS ||
  process.env.LCD_URL ||
  "https://terra-classic-lcd.publicnode.com"
)
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

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
 * Safety lag for /latest-block: min(tip samples across all upstreams) - LAG.
 * Tendermint has instant finality; the lag only covers load-balanced nodes that
 * are a few blocks behind each other and tx-index commit latency.
 */
export const LATEST_BLOCK_LAG = intEnv("LATEST_BLOCK_LAG", 5);
export const LATEST_BLOCK_SAMPLES = intEnv("LATEST_BLOCK_SAMPLES", 3, 1);

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
