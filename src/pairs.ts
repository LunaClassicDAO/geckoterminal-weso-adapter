import {
  BONDING_CURVES,
  DEX_KEY,
  EXCLUDED_PAIR_TYPES,
  FACTORY,
  NATIVE_ASSETS,
  PAIR_CACHE_TTL_MS,
} from "./config.js";
import { rateToBps } from "./decimal.js";
import type { PairDef } from "./parse.js";
import type { FactoryPair, Pair } from "./types.js";
import { ApiError, Session } from "./upstream.js";
import { assetIdFromInfo, pairTypeKey } from "./utils.js";

export interface ResolvedPair {
  pair: Pair;
  def: PairDef;
}

interface PairCache {
  at: number;
  list: ResolvedPair[];
  byId: Map<string, ResolvedPair>;
}

let cache: PairCache | null = null;
let inflight: Promise<PairCache> | null = null;

interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
}

export async function tokenInfo(s: Session, id: string): Promise<TokenInfo> {
  const info = await s.smart<TokenInfo>(id, { token_info: {} });
  if (
    typeof info?.symbol !== "string" ||
    !info.symbol ||
    typeof info.name !== "string" ||
    !Number.isInteger(info.decimals)
  ) {
    throw new ApiError(502, "upstream_bad_response", "Token returned malformed token_info");
  }
  return info;
}

async function symbolAndDecimals(s: Session, id: string): Promise<{ symbol: string; decimals: number }> {
  const n = NATIVE_ASSETS[id];
  if (n) return { symbol: n.symbol, decimals: n.decimals };
  if (!id.startsWith("terra1")) {
    throw new ApiError(502, "unsupported_asset", "Pair references an unsupported asset type");
  }
  const t = await tokenInfo(s, id);
  return { symbol: t.symbol, decimals: t.decimals };
}

async function loadFactoryPairs(s: Session): Promise<ResolvedPair[]> {
  const all: FactoryPair[] = [];
  for (;;) {
    const query: { pairs: { limit: number; start_after?: unknown } } = { pairs: { limit: 30 } };
    if (all.length) query.pairs.start_after = all[all.length - 1].asset_infos;
    const { pairs } = await s.smart<{ pairs: FactoryPair[] }>(FACTORY, query);
    if (!Array.isArray(pairs)) throw new ApiError(502, "upstream_bad_response", "Factory returned malformed pairs");
    if (!pairs.length) break;
    all.push(...pairs);
    if (all.length > 10_000) throw new ApiError(502, "upstream_bad_response", "Factory pagination did not terminate");
  }

  const out: ResolvedPair[] = [];
  for (const fp of all) {
    const pairType = pairTypeKey(fp.pair_type);
    if (EXCLUDED_PAIR_TYPES.has(pairType)) continue;
    const asset0Id = assetIdFromInfo(fp.asset_infos?.[0]);
    const asset1Id = assetIdFromInfo(fp.asset_infos?.[1]);
    if (!asset0Id || !asset1Id || !fp.contract_addr) {
      throw new ApiError(502, "upstream_bad_response", "Factory returned a pair without assets");
    }
    const [a0, a1] = await Promise.all([symbolAndDecimals(s, asset0Id), symbolAndDecimals(s, asset1Id)]);
    const d0 = fp.asset_decimals?.[0] ?? a0.decimals;
    const d1 = fp.asset_decimals?.[1] ?? a1.decimals;
    if (d0 !== a0.decimals || d1 !== a1.decimals) {
      throw new ApiError(502, "upstream_inconsistent", "Pair asset_decimals disagree with token_info");
    }
    const cfg = await s.smart<{ commission_rate?: string }>(fp.contract_addr, { config: {} });
    if (typeof cfg?.commission_rate !== "string") {
      throw new ApiError(502, "upstream_bad_response", "Pair config has no commission_rate");
    }
    const feeBps = rateToBps(cfg.commission_rate);
    const pair: Pair = {
      id: fp.contract_addr,
      dexKey: DEX_KEY,
      asset0Id,
      asset1Id,
      name: `${a0.symbol}/${a1.symbol}`,
      feeBps,
      metadata: {
        pairType,
        factory: FACTORY,
        liquidityToken: fp.liquidity_token || "",
        commissionRate: cfg.commission_rate,
      },
    };
    out.push({
      pair,
      def: { id: fp.contract_addr, asset0Id, asset1Id, asset0Decimals: d0, asset1Decimals: d1, kind: "amm" },
    });
  }
  return out;
}

async function loadCurves(s: Session): Promise<ResolvedPair[]> {
  const out: ResolvedPair[] = [];
  for (const c of BONDING_CURVES) {
    const native = NATIVE_ASSETS[c.reserveDenom];
    const tok = await tokenInfo(s, c.id);
    const params = await s.smart<{ project_tax_pct?: number }>(c.id, { param_info: {} });
    if (!Number.isInteger(params?.project_tax_pct)) {
      throw new ApiError(502, "upstream_bad_response", "Curve param_info has no project_tax_pct");
    }
    // project_tax_pct is per-mille (the pool split fields sum to 1000): 10 = 1% = 100 bps
    const feeBps = (params.project_tax_pct as number) * 10;
    const pair: Pair = {
      id: c.id,
      dexKey: DEX_KEY,
      asset0Id: c.reserveDenom,
      asset1Id: c.id,
      name: `${native.symbol}/${tok.symbol}`,
      feeBps,
      metadata: {
        pairType: "cw20_bonding",
        reserveDenom: c.reserveDenom,
        projectTaxPerMille: String(params.project_tax_pct),
        reserves:
          "asset0 = native bank balance of the curve contract; asset1 = 0 (curve tokens are minted/burned on trade, none are pooled)",
      },
    };
    out.push({
      pair,
      def: {
        id: c.id,
        asset0Id: c.reserveDenom,
        asset1Id: c.id,
        asset0Decimals: native.decimals,
        asset1Decimals: tok.decimals,
        kind: "curve",
      },
    });
  }
  return out;
}

async function load(): Promise<PairCache> {
  const s = new Session();
  const list = [...(await loadFactoryPairs(s)), ...(await loadCurves(s))];
  const byId = new Map(list.map((p) => [p.pair.id, p] as const));
  return { at: Date.now(), list, byId };
}

async function getCache(): Promise<PairCache> {
  if (cache && Date.now() - cache.at < PAIR_CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = load()
      .then((c) => {
        cache = c;
        return c;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** All GT pairs: factory AMM pairs (reflective/cumulative) + product bonding curves. */
export async function listPairs(): Promise<ResolvedPair[]> {
  return (await getCache()).list;
}

export async function getPair(id: string): Promise<ResolvedPair> {
  const hit = (await getCache()).byId.get(id);
  if (!hit) throw new ApiError(404, "not_found", "Unknown or excluded pair");
  return hit;
}

/** Test hook. */
export function setPairsForTest(list: ResolvedPair[] | null): void {
  cache = list ? { at: Number.MAX_SAFE_INTEGER / 2, list, byId: new Map(list.map((p) => [p.pair.id, p])) } : null;
}
