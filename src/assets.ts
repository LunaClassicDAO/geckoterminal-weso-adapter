import {
  ASSET_CACHE_TTL_MS,
  ASSET_OVERRIDES,
  BONDING_CURVE_IDS,
  CWLUNC,
  CWUSTC,
  NATIVE_ASSETS,
} from "./config.js";
import { querySmart } from "./lcd.js";
import type { Asset } from "./types.js";
import { decimalize } from "./utils.js";

type CacheEntry = { at: number; asset: Asset };
const cache = new Map<string, CacheEntry>();

function overrideKind(id: string): string {
  if (BONDING_CURVE_IDS.has(id)) return "cw20_bonding";
  if (id === CWLUNC || id === CWUSTC) return "cw20_wrap";
  return "cw20";
}

export async function getAsset(id: string): Promise<Asset> {
  const key = id;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ASSET_CACHE_TTL_MS) return hit.asset;

  const override = ASSET_OVERRIDES[id];
  const native = NATIVE_ASSETS[id];

  if (native) {
    const asset: Asset = {
      id,
      name: native.name,
      symbol: native.symbol,
      decimals: native.decimals,
      ...(native.coinGeckoId ? { coinGeckoId: native.coinGeckoId } : {}),
      metadata: { kind: "native", denom: id },
    };
    cache.set(key, { at: Date.now(), asset });
    return asset;
  }

  if (override) {
    // Overrides are authoritative for wraps (CWLUNC/CWUSTC).
    // Bonding curves: confirm via token_info but keep override as fallback.
    let totalSupply: string | undefined;
    let name = override.name;
    let symbol = override.symbol;
    let decimals = override.decimals;
    try {
      const info = await querySmart<{
        name: string;
        symbol: string;
        decimals: number;
        total_supply: string;
      }>(id, { token_info: {} });
      if (BONDING_CURVE_IDS.has(id)) {
        if (info?.name) name = info.name;
        if (info?.symbol) symbol = info.symbol;
        if (info?.decimals != null && Number.isFinite(Number(info.decimals))) {
          decimals = Number(info.decimals);
        }
      } else if (info?.decimals != null && Number.isFinite(Number(info.decimals))) {
        // wraps: keep override symbol/name; allow decimals confirm
        decimals = override.decimals;
      }
      if (info?.total_supply) {
        totalSupply = decimalize(info.total_supply, decimals);
      }
    } catch {
      /* optional — keep overrides */
    }
    const asset: Asset = {
      id,
      name,
      symbol,
      decimals,
      ...(totalSupply ? { totalSupply } : {}),
      ...(override.coinGeckoId ? { coinGeckoId: override.coinGeckoId } : {}),
      metadata: { kind: overrideKind(id) },
    };
    cache.set(key, { at: Date.now(), asset });
    return asset;
  }

  // CW20 / other contract
  if (!id.startsWith("terra1") && !id.startsWith("ibc/")) {
    throw Object.assign(new Error(`Unknown asset id: ${id}`), { status: 404 });
  }

  if (id.startsWith("ibc/")) {
    const asset: Asset = {
      id,
      name: id.slice(0, 16) + "…",
      symbol: "IBC",
      decimals: 6,
      metadata: { kind: "ibc" },
    };
    cache.set(key, { at: Date.now(), asset });
    return asset;
  }

  const info = await querySmart<{
    name: string;
    symbol: string;
    decimals: number;
    total_supply: string;
  }>(id, { token_info: {} });

  const decimals = Number(info.decimals);
  const asset: Asset = {
    id,
    name: info.name || info.symbol || id,
    symbol: info.symbol || "UNKNOWN",
    decimals: Number.isFinite(decimals) ? decimals : 6,
    totalSupply: info.total_supply
      ? decimalize(info.total_supply, Number.isFinite(decimals) ? decimals : 6)
      : undefined,
    metadata: { kind: BONDING_CURVE_IDS.has(id) ? "cw20_bonding" : "cw20" },
  };
  if (!asset.symbol) asset.symbol = "UNKNOWN";
  if (!asset.name) asset.name = asset.symbol;
  cache.set(key, { at: Date.now(), asset });
  return asset;
}

export function peekAssetDecimals(id: string, fallback = 6): number {
  const hit = cache.get(id);
  if (hit) return hit.asset.decimals;
  if (NATIVE_ASSETS[id]) return NATIVE_ASSETS[id].decimals;
  if (ASSET_OVERRIDES[id]) return ASSET_OVERRIDES[id].decimals;
  return fallback;
}

export async function ensureAssetDecimals(id: string): Promise<number> {
  const a = await getAsset(id);
  return a.decimals;
}
