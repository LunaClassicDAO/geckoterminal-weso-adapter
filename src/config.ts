export const PORT = Number(process.env.PORT || 8080);

export const LCD_URL = (
  process.env.LCD_URL || "https://terra-classic-lcd.publicnode.com"
).replace(/\/$/, "");

export const FCD_URL = (
  process.env.FCD_URL || "https://terra-classic-fcd.publicnode.com"
).replace(/\/$/, "");

export const FACTORY =
  process.env.FACTORY ||
  "terra1veqa6znu8lfdmz9kp9v047chfmn84q5k3pacme75gl8ywmplk92q6xnq2k";

export const ROUTER =
  process.env.ROUTER ||
  "terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8";

export const DEX_KEY = process.env.DEX_KEY || "weso-defi";

export const PAIR_CACHE_TTL_MS = Number(process.env.PAIR_CACHE_TTL_MS || 300_000);
export const ASSET_CACHE_TTL_MS = Number(process.env.ASSET_CACHE_TTL_MS || 600_000);
export const MAX_EVENTS_BLOCK_SPAN = Number(
  process.env.MAX_EVENTS_BLOCK_SPAN || 2000,
);
export const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 45_000);

/**
 * Match DeFiLlama WESO factory exclusions (wrap/unwrap + converter).
 * These factory `token_bonding` vaults are LUNC↔CWLUNC / USTC↔CWUSTC plumbing —
 * NOT the product bonding curves ($WESO / $reBASE) listed below.
 */
export const EXCLUDED_PAIR_TYPES = new Set(["token_bonding", "converter"]);

export const CWLUNC =
  "terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6";
export const CWUSTC =
  "terra1uncwzdhxdktqpx4rj6mkuhl0ekv0raua0058rr7zgnapm9najyyqgtpf6h";

/** Product cw20 bonding curves (first-class GT pairs in v1). */
export const WESO_CURVE =
  "terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms";
export const REBASE_CURVE =
  "terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m";

export interface BondingCurveDef {
  id: string;
  /** Native reserve denom → asset0Id */
  reserveDenom: string;
  /** Display fallbacks if token_info is unreachable */
  symbol: string;
  name: string;
  decimals: number;
  /**
   * Curve commission_amount in wasm events is 0; project_tax is separate (~1%).
   * Documented default feeBps for GT pair schema.
   */
  feeBps: number;
}

export const BONDING_CURVES: BondingCurveDef[] = [
  {
    id: WESO_CURVE,
    reserveDenom: "uluna",
    symbol: "WESO",
    name: "WESO Token",
    decimals: 6,
    feeBps: 0,
  },
  {
    id: REBASE_CURVE,
    reserveDenom: "uusd",
    symbol: "reBASE",
    name: "reBASE",
    decimals: 6,
    feeBps: 0,
  },
];

export const BONDING_CURVE_IDS = new Set(BONDING_CURVES.map((c) => c.id));

/** Known native denoms on Terra Classic (columbus-5). */
export const NATIVE_ASSETS: Record<
  string,
  { name: string; symbol: string; decimals: number; coinGeckoId?: string }
> = {
  uluna: {
    name: "Luna Classic",
    symbol: "LUNC",
    decimals: 6,
    coinGeckoId: "terra-luna",
  },
  uusd: {
    name: "TerraClassicUSD",
    symbol: "USTC",
    decimals: 6,
    coinGeckoId: "terrausd",
  },
};

/**
 * Override CW20 symbols/names. Wrap tokens keep explorer-facing contract IDs.
 * Product curves use token_info when available; overrides ensure stable symbols.
 */
export const ASSET_OVERRIDES: Record<
  string,
  { name: string; symbol: string; decimals: number; coinGeckoId?: string }
> = {
  [CWLUNC]: {
    name: "Wrapped LUNC (CW20)",
    symbol: "CWLUNC",
    decimals: 6,
  },
  [CWUSTC]: {
    name: "Wrapped USTC (CW20)",
    symbol: "CWUSTC",
    decimals: 6,
  },
  [WESO_CURVE]: {
    name: "WESO Token",
    symbol: "WESO",
    decimals: 6,
  },
  [REBASE_CURVE]: {
    name: "reBASE",
    symbol: "reBASE",
    decimals: 6,
  },
};
