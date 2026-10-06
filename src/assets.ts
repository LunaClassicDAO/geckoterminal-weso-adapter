import { ASSET_CACHE_TTL_MS, BONDING_CURVE_IDS, CWLUNC, CWUSTC, NATIVE_ASSETS } from "./config.js";
import { decimalize } from "./decimal.js";
import { listPairs, tokenInfo } from "./pairs.js";
import type { Asset } from "./types.js";
import { ApiError, Session } from "./upstream.js";

type CacheEntry = { at: number; asset: Asset };
const cache = new Map<string, CacheEntry>();

/**
 * Asset info straight from chain. Only assets that belong to a listed pair are
 * served; anything else (including ibc/* denoms) is a 404 rather than made-up
 * data. CW20 name/symbol/decimals/totalSupply come verbatim from token_info.
 * coinGeckoId is only set for the two native denoms whose CoinGecko ids are
 * unambiguous (uluna -> terra-luna, uusd -> terrausd).
 */
export async function getAsset(id: string): Promise<Asset> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < ASSET_CACHE_TTL_MS) return hit.asset;

  const pairs = await listPairs();
  const known = pairs.some((p) => p.pair.asset0Id === id || p.pair.asset1Id === id);
  if (!known) throw new ApiError(404, "not_found", "Unknown asset (not part of any listed pair)");

  let asset: Asset;
  const native = NATIVE_ASSETS[id];
  if (native) {
    asset = {
      id,
      name: native.name,
      symbol: native.symbol,
      decimals: native.decimals,
      coinGeckoId: native.coinGeckoId,
      metadata: { kind: "native", denom: id },
    };
  } else if (id.startsWith("terra1")) {
    const info = await tokenInfo(new Session(), id);
    if (typeof info.total_supply !== "string" || !/^\d+$/.test(info.total_supply)) {
      throw new ApiError(502, "upstream_bad_response", "Token returned malformed total_supply");
    }
    const kind = BONDING_CURVE_IDS.has(id) ? "cw20_bonding" : id === CWLUNC || id === CWUSTC ? "cw20_wrap" : "cw20";
    asset = {
      id,
      name: info.name,
      symbol: info.symbol,
      decimals: info.decimals,
      totalSupply: decimalize(info.total_supply, info.decimals),
      metadata: { kind },
    };
  } else {
    throw new ApiError(404, "not_found", "Unsupported asset id");
  }
  cache.set(id, { at: Date.now(), asset });
  return asset;
}
