import {
  BONDING_CURVES,
  BONDING_CURVE_IDS,
  DEX_KEY,
  EXCLUDED_PAIR_TYPES,
  FACTORY,
  PAIR_CACHE_TTL_MS,
} from "./config.js";
import { querySmart } from "./lcd.js";
import { getAsset } from "./assets.js";
import type { FactoryPair, Pair, PoolAsset } from "./types.js";
import { assetIdFromInfo, pairTypeKey, safeSymbol } from "./utils.js";

interface PairCache {
  at: number;
  byId: Map<string, ResolvedPair>;
  list: ResolvedPair[];
}

export interface ResolvedPair {
  factory?: FactoryPair;
  pair: Pair;
  asset0Decimals: number;
  asset1Decimals: number;
  pairType: string;
  /** True for $WESO / $reBASE cw20 bonding curves (not factory AMM). */
  bondingCurve?: boolean;
}

let cache: PairCache | null = null;

async function loadBondingCurvePairs(): Promise<ResolvedPair[]> {
  const out: ResolvedPair[] = [];
  for (const def of BONDING_CURVES) {
    const asset0Id = def.reserveDenom;
    const asset1Id = def.id;
    const a0 = await getAsset(asset0Id);
    const a1 = await getAsset(asset1Id);
    const d0 = a0.decimals;
    const d1 = a1.decimals;

    // Prefer live token_info symbol if override/query succeeded
    const tokenSymbol = a1.symbol || def.symbol;
    const nativeSymbol = a0.symbol;
    // asset0 = native → name NATIVE/TOKEN (e.g. LUNC/WESO, USTC/reBASE)
    const name = safeSymbol(nativeSymbol, tokenSymbol);

    const pair: Pair = {
      id: def.id,
      dexKey: DEX_KEY,
      asset0Id,
      asset1Id,
      name,
      feeBps: def.feeBps,
      metadata: {
        pairType: "cw20_bonding",
        bondingCurve: "true",
        reserveDenom: def.reserveDenom,
        note: "commission_amount=0; project_tax ~1% separate from feeBps",
      },
    };

    out.push({
      pair,
      asset0Decimals: d0,
      asset1Decimals: d1,
      pairType: "cw20_bonding",
      bondingCurve: true,
    });
  }
  return out;
}

async function loadPairs(force = false): Promise<PairCache> {
  if (
    !force &&
    cache &&
    Date.now() - cache.at < PAIR_CACHE_TTL_MS &&
    cache.list.length
  ) {
    return cache;
  }

  const all: FactoryPair[] = [];
  let page: FactoryPair[];
  do {
    const query: { pairs: { limit: number; start_after?: unknown } } = {
      pairs: { limit: 30 },
    };
    if (all.length) {
      query.pairs.start_after = all[all.length - 1].asset_infos;
    }
    const { pairs } = await querySmart<{ pairs: FactoryPair[] }>(FACTORY, query);
    if (!Array.isArray(pairs)) {
      throw new Error("WESO factory returned a malformed pairs response");
    }
    page = pairs;
    all.push(...page);
  } while (page.length > 0);

  // Exclude wrap vaults (token_bonding) and converter — not product curves.
  const included = all.filter(
    (p) => !EXCLUDED_PAIR_TYPES.has(pairTypeKey(p.pair_type)),
  );

  const byId = new Map<string, ResolvedPair>();
  const list: ResolvedPair[] = [];

  for (const fp of included) {
    const asset0Id = assetIdFromInfo(fp.asset_infos?.[0]);
    const asset1Id = assetIdFromInfo(fp.asset_infos?.[1]);
    if (!asset0Id || !asset1Id || !fp.contract_addr) continue;

    // Prefer on-chain asset_decimals; fall back to token_info.
    let d0 = fp.asset_decimals?.[0];
    let d1 = fp.asset_decimals?.[1];
    const a0 = await getAsset(asset0Id);
    const a1 = await getAsset(asset1Id);
    if (d0 == null) d0 = a0.decimals;
    if (d1 == null) d1 = a1.decimals;

    let feeBps = 20; // commission_rate 0.002 default
    try {
      const cfg = await querySmart<{ commission_rate?: string }>(
        fp.contract_addr,
        { config: {} },
      );
      if (cfg?.commission_rate != null) {
        const rate = Number(cfg.commission_rate);
        if (Number.isFinite(rate) && rate >= 0) {
          feeBps = Math.round(rate * 10_000);
        }
      }
    } catch {
      /* keep default */
    }

    const name = safeSymbol(a0.symbol, a1.symbol);
    const pairType = pairTypeKey(fp.pair_type) || "amm";
    const pair: Pair = {
      id: fp.contract_addr,
      dexKey: DEX_KEY,
      asset0Id,
      asset1Id,
      name,
      feeBps,
      metadata: {
        pairType,
        factory: FACTORY,
        liquidityToken: fp.liquidity_token || "",
      },
    };

    const resolved: ResolvedPair = {
      factory: fp,
      pair,
      asset0Decimals: d0,
      asset1Decimals: d1,
      pairType,
    };
    byId.set(fp.contract_addr, resolved);
    list.push(resolved);
  }

  // Append product bonding curves as first-class pairs (v1).
  for (const curve of await loadBondingCurvePairs()) {
    byId.set(curve.pair.id, curve);
    list.push(curve);
  }

  cache = { at: Date.now(), byId, list };
  return cache;
}

/** All GT pairs: factory AMM (reflective/cumulative) + product bonding curves. */
export async function listPairs(): Promise<ResolvedPair[]> {
  return (await loadPairs()).list;
}

/** @deprecated alias — prefer listPairs */
export async function listAmmPairs(): Promise<ResolvedPair[]> {
  return listPairs();
}

export async function getPair(id: string): Promise<ResolvedPair> {
  const c = await loadPairs();
  const hit = c.byId.get(id);
  if (!hit) {
    const reason = BONDING_CURVE_IDS.has(id)
      ? `Unknown pair: ${id}`
      : `Unknown or excluded pair: ${id}`;
    throw Object.assign(new Error(reason), { status: 404 });
  }
  return hit;
}

export interface CurveInfo {
  reserve: string;
  supply: string;
  spot_price?: string;
  reserve_denom?: string;
  tax_collected?: string;
}

export async function getCurveReserves(
  curveId: string,
  height?: number,
): Promise<{ reserve0: string; reserve1: string }> {
  const info = await querySmart<CurveInfo>(curveId, { curve_info: {} }, height);
  // asset0 = native reserve, asset1 = circulating curve supply (CW20 minted)
  return {
    reserve0: info.reserve || "0",
    reserve1: info.supply || "0",
  };
}

export async function getPoolReserves(
  pairId: string,
  height?: number,
): Promise<{ reserve0: string; reserve1: string }> {
  const resolved = await getPair(pairId);

  if (resolved.bondingCurve || BONDING_CURVE_IDS.has(pairId)) {
    return getCurveReserves(pairId, height);
  }

  const pool = await querySmart<{ assets: PoolAsset[] }>(
    pairId,
    { pool: {} },
    height,
  );
  const assets = pool.assets || [];
  // Map by asset id to preserve pair asset0/asset1 order
  const amounts = new Map<string, string>();
  for (const a of assets) {
    const id = assetIdFromInfo(a.info);
    if (id) amounts.set(id, a.amount || "0");
  }
  const r0 = amounts.get(resolved.pair.asset0Id) || "0";
  const r1 = amounts.get(resolved.pair.asset1Id) || "0";
  return { reserve0: r0, reserve1: r1 };
}

export function invalidatePairCache(): void {
  cache = null;
}
