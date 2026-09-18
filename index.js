"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_cors = __toESM(require("cors"), 1);
var import_express = __toESM(require("express"), 1);
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);

// src/config.ts
var PORT = Number(process.env.PORT || 8080);
var LCD_URL = (process.env.LCD_URL || "https://terra-classic-lcd.publicnode.com").replace(/\/$/, "");
var FCD_URL = (process.env.FCD_URL || "https://terra-classic-fcd.publicnode.com").replace(/\/$/, "");
var FACTORY = process.env.FACTORY || "terra1veqa6znu8lfdmz9kp9v047chfmn84q5k3pacme75gl8ywmplk92q6xnq2k";
var ROUTER = process.env.ROUTER || "terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8";
var DEX_KEY = process.env.DEX_KEY || "weso-defi";
var PAIR_CACHE_TTL_MS = Number(process.env.PAIR_CACHE_TTL_MS || 3e5);
var ASSET_CACHE_TTL_MS = Number(process.env.ASSET_CACHE_TTL_MS || 6e5);
var MAX_EVENTS_BLOCK_SPAN = Number(
  process.env.MAX_EVENTS_BLOCK_SPAN || 2e3
);
var HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 45e3);
var EXCLUDED_PAIR_TYPES = /* @__PURE__ */ new Set(["token_bonding", "converter"]);
var CWLUNC = "terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6";
var CWUSTC = "terra1uncwzdhxdktqpx4rj6mkuhl0ekv0raua0058rr7zgnapm9najyyqgtpf6h";
var WESO_CURVE = "terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms";
var REBASE_CURVE = "terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m";
var BONDING_CURVES = [
  {
    id: WESO_CURVE,
    reserveDenom: "uluna",
    symbol: "WESO",
    name: "WESO Token",
    decimals: 6,
    feeBps: 0
  },
  {
    id: REBASE_CURVE,
    reserveDenom: "uusd",
    symbol: "reBASE",
    name: "reBASE",
    decimals: 6,
    feeBps: 0
  }
];
var BONDING_CURVE_IDS = new Set(BONDING_CURVES.map((c) => c.id));
var NATIVE_ASSETS = {
  uluna: {
    name: "Luna Classic",
    symbol: "LUNC",
    decimals: 6,
    coinGeckoId: "terra-luna"
  },
  uusd: {
    name: "TerraClassicUSD",
    symbol: "USTC",
    decimals: 6,
    coinGeckoId: "terrausd"
  }
};
var ASSET_OVERRIDES = {
  [CWLUNC]: {
    name: "Wrapped LUNC (CW20)",
    symbol: "CWLUNC",
    decimals: 6
  },
  [CWUSTC]: {
    name: "Wrapped USTC (CW20)",
    symbol: "CWUSTC",
    decimals: 6
  },
  [WESO_CURVE]: {
    name: "WESO Token",
    symbol: "WESO",
    decimals: 6
  },
  [REBASE_CURVE]: {
    name: "reBASE",
    symbol: "reBASE",
    decimals: 6
  }
};

// src/lcd.ts
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; WESO-GeckoTerminal-Adapter/1.0)",
  Accept: "application/json"
};
var LcdError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "LcdError";
  }
  status;
};
async function fetchJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...HEADERS, ...init?.headers },
      signal: ctrl.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LcdError(
        `HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`,
        res.status
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function querySmart(contract, query, height) {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  let url = `${LCD_URL}/cosmwasm/wasm/v1/contract/${contract}/smart/${encoded}`;
  const headers = { ...HEADERS };
  if (height != null && Number.isFinite(height)) {
    url += `?height=${height}`;
    headers["x-cosmos-block-height"] = String(height);
  }
  const res = await fetchJson(url, { headers });
  if (res == null || res.data === void 0) {
    throw new LcdError(`Smart query returned no data for ${contract}`);
  }
  return res.data;
}
async function getLatestBlock() {
  const res = await fetchJson(`${LCD_URL}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  const height = Number(res.block.header.height);
  const ts = Math.floor(Date.parse(res.block.header.time) / 1e3);
  if (!Number.isFinite(height) || !Number.isFinite(ts)) {
    throw new LcdError("Invalid latest block payload");
  }
  return { blockNumber: height, blockTimestamp: ts };
}
async function searchTxsByContractAndHeight(contract, fromBlock, toBlock, limit = 100) {
  const q = `tx.height>=${fromBlock} AND tx.height<=${toBlock} AND wasm._contract_address='${contract}'`;
  const url = `${LCD_URL}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(q)}&pagination.limit=${limit}&order_by=2`;
  const res = await fetchJson(url);
  return res.tx_responses || [];
}

// src/utils.ts
function pairTypeKey(pairType) {
  if (!pairType) return "";
  if (typeof pairType === "string") return pairType.toLowerCase();
  if (typeof pairType === "object") {
    const key = Object.keys(pairType)[0];
    if (key === "custom" && typeof pairType.custom === "string") {
      return pairType.custom.toLowerCase();
    }
    return (key || "").toLowerCase();
  }
  return "";
}
function assetIdFromInfo(info) {
  if (!info) return null;
  if ("native_token" in info && info.native_token?.denom) {
    return info.native_token.denom;
  }
  if ("token" in info && info.token?.contract_addr) {
    return info.token.contract_addr;
  }
  return null;
}
function normalizeAssetAttr(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j.native || j.native_token) {
        return j.native || j.native_token?.denom || j.native_token;
      }
      if (j.cw20 || j.token) {
        return j.cw20 || j.token?.contract_addr || j.token;
      }
    } catch {
    }
  }
  return s;
}
function decimalize(raw, decimals) {
  const neg = false;
  let s = typeof raw === "bigint" ? raw.toString() : String(raw);
  if (!/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return "0";
    return trimZeros(n.toFixed(Math.min(50, Math.max(decimals, 18))));
  }
  const pad = decimals;
  if (s.length <= pad) {
    s = s.padStart(pad + 1, "0");
  }
  const whole = s.slice(0, s.length - pad) || "0";
  const frac = s.slice(s.length - pad).padEnd(pad, "0");
  const out = trimZeros(`${neg ? "-" : ""}${whole}.${frac}`);
  return out === "" || out === "." ? "0" : out;
}
function trimZeros(x) {
  if (!x.includes(".")) return x;
  return x.replace(/\.?0+$/, "") || "0";
}
function priceNativeFromTrade(opts) {
  const r0 = Number(opts.reserve0);
  const r1 = Number(opts.reserve1);
  let price = null;
  if (opts.asset0In && opts.asset1Out) {
    const a0 = Number(opts.asset0In);
    const a1 = Number(opts.asset1Out);
    if (a0 > 0 && a1 > 0) price = a1 / a0;
  } else if (opts.asset1In && opts.asset0Out) {
    const a1 = Number(opts.asset1In);
    const a0 = Number(opts.asset0Out);
    if (a0 > 0 && a1 > 0) price = a1 / a0;
  }
  if ((price == null || !(price > 0)) && r0 > 0 && r1 > 0) {
    price = r1 / r0;
  }
  if (price == null || !(price > 0) || !Number.isFinite(price)) {
    return "0.000000000000000001";
  }
  return price.toFixed(50).replace(/\.?0+$/, "") || String(price);
}
function parseIsoToUnix(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1e3);
}
function splitWasmSections(attributes) {
  const sections = [];
  let cur = null;
  for (const a of attributes) {
    const key = a.key;
    const value = a.value;
    if (key === "_contract_address" || key === "contract_address") {
      if (cur) sections.push(cur);
      cur = { _contract_address: value };
      continue;
    }
    if (!cur) cur = {};
    if (!(key in cur)) cur[key] = value;
    else if (key === "action") {
    }
  }
  if (cur) sections.push(cur);
  return sections;
}
function safeSymbol(...parts) {
  const s = parts.filter(Boolean).join("/");
  return s || "UNKNOWN/UNKNOWN";
}

// src/assets.ts
var cache = /* @__PURE__ */ new Map();
function overrideKind(id) {
  if (BONDING_CURVE_IDS.has(id)) return "cw20_bonding";
  if (id === CWLUNC || id === CWUSTC) return "cw20_wrap";
  return "cw20";
}
async function getAsset(id) {
  const key = id;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ASSET_CACHE_TTL_MS) return hit.asset;
  const override = ASSET_OVERRIDES[id];
  const native = NATIVE_ASSETS[id];
  if (native) {
    const asset2 = {
      id,
      name: native.name,
      symbol: native.symbol,
      decimals: native.decimals,
      ...native.coinGeckoId ? { coinGeckoId: native.coinGeckoId } : {},
      metadata: { kind: "native", denom: id }
    };
    cache.set(key, { at: Date.now(), asset: asset2 });
    return asset2;
  }
  if (override) {
    let totalSupply;
    let name = override.name;
    let symbol = override.symbol;
    let decimals2 = override.decimals;
    try {
      const info2 = await querySmart(id, { token_info: {} });
      if (BONDING_CURVE_IDS.has(id)) {
        if (info2?.name) name = info2.name;
        if (info2?.symbol) symbol = info2.symbol;
        if (info2?.decimals != null && Number.isFinite(Number(info2.decimals))) {
          decimals2 = Number(info2.decimals);
        }
      } else if (info2?.decimals != null && Number.isFinite(Number(info2.decimals))) {
        decimals2 = override.decimals;
      }
      if (info2?.total_supply) {
        totalSupply = decimalize(info2.total_supply, decimals2);
      }
    } catch {
    }
    const asset2 = {
      id,
      name,
      symbol,
      decimals: decimals2,
      ...totalSupply ? { totalSupply } : {},
      ...override.coinGeckoId ? { coinGeckoId: override.coinGeckoId } : {},
      metadata: { kind: overrideKind(id) }
    };
    cache.set(key, { at: Date.now(), asset: asset2 });
    return asset2;
  }
  if (!id.startsWith("terra1") && !id.startsWith("ibc/")) {
    throw Object.assign(new Error(`Unknown asset id: ${id}`), { status: 404 });
  }
  if (id.startsWith("ibc/")) {
    const asset2 = {
      id,
      name: id.slice(0, 16) + "\u2026",
      symbol: "IBC",
      decimals: 6,
      metadata: { kind: "ibc" }
    };
    cache.set(key, { at: Date.now(), asset: asset2 });
    return asset2;
  }
  const info = await querySmart(id, { token_info: {} });
  const decimals = Number(info.decimals);
  const asset = {
    id,
    name: info.name || info.symbol || id,
    symbol: info.symbol || "UNKNOWN",
    decimals: Number.isFinite(decimals) ? decimals : 6,
    totalSupply: info.total_supply ? decimalize(info.total_supply, Number.isFinite(decimals) ? decimals : 6) : void 0,
    metadata: { kind: BONDING_CURVE_IDS.has(id) ? "cw20_bonding" : "cw20" }
  };
  if (!asset.symbol) asset.symbol = "UNKNOWN";
  if (!asset.name) asset.name = asset.symbol;
  cache.set(key, { at: Date.now(), asset });
  return asset;
}

// src/pairs.ts
var cache2 = null;
async function loadBondingCurvePairs() {
  const out = [];
  for (const def of BONDING_CURVES) {
    const asset0Id = def.reserveDenom;
    const asset1Id = def.id;
    const a0 = await getAsset(asset0Id);
    const a1 = await getAsset(asset1Id);
    const d0 = a0.decimals;
    const d1 = a1.decimals;
    const tokenSymbol = a1.symbol || def.symbol;
    const nativeSymbol = a0.symbol;
    const name = safeSymbol(nativeSymbol, tokenSymbol);
    const pair = {
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
        note: "commission_amount=0; project_tax ~1% separate from feeBps"
      }
    };
    out.push({
      pair,
      asset0Decimals: d0,
      asset1Decimals: d1,
      pairType: "cw20_bonding",
      bondingCurve: true
    });
  }
  return out;
}
async function loadPairs(force = false) {
  if (!force && cache2 && Date.now() - cache2.at < PAIR_CACHE_TTL_MS && cache2.list.length) {
    return cache2;
  }
  const all = [];
  let page;
  do {
    const query = {
      pairs: { limit: 30 }
    };
    if (all.length) {
      query.pairs.start_after = all[all.length - 1].asset_infos;
    }
    const { pairs } = await querySmart(FACTORY, query);
    if (!Array.isArray(pairs)) {
      throw new Error("WESO factory returned a malformed pairs response");
    }
    page = pairs;
    all.push(...page);
  } while (page.length > 0);
  const included = all.filter(
    (p) => !EXCLUDED_PAIR_TYPES.has(pairTypeKey(p.pair_type))
  );
  const byId = /* @__PURE__ */ new Map();
  const list = [];
  for (const fp of included) {
    const asset0Id = assetIdFromInfo(fp.asset_infos?.[0]);
    const asset1Id = assetIdFromInfo(fp.asset_infos?.[1]);
    if (!asset0Id || !asset1Id || !fp.contract_addr) continue;
    let d0 = fp.asset_decimals?.[0];
    let d1 = fp.asset_decimals?.[1];
    const a0 = await getAsset(asset0Id);
    const a1 = await getAsset(asset1Id);
    if (d0 == null) d0 = a0.decimals;
    if (d1 == null) d1 = a1.decimals;
    let feeBps = 20;
    try {
      const cfg = await querySmart(
        fp.contract_addr,
        { config: {} }
      );
      if (cfg?.commission_rate != null) {
        const rate = Number(cfg.commission_rate);
        if (Number.isFinite(rate) && rate >= 0) {
          feeBps = Math.round(rate * 1e4);
        }
      }
    } catch {
    }
    const name = safeSymbol(a0.symbol, a1.symbol);
    const pairType = pairTypeKey(fp.pair_type) || "amm";
    const pair = {
      id: fp.contract_addr,
      dexKey: DEX_KEY,
      asset0Id,
      asset1Id,
      name,
      feeBps,
      metadata: {
        pairType,
        factory: FACTORY,
        liquidityToken: fp.liquidity_token || ""
      }
    };
    const resolved = {
      factory: fp,
      pair,
      asset0Decimals: d0,
      asset1Decimals: d1,
      pairType
    };
    byId.set(fp.contract_addr, resolved);
    list.push(resolved);
  }
  for (const curve of await loadBondingCurvePairs()) {
    byId.set(curve.pair.id, curve);
    list.push(curve);
  }
  cache2 = { at: Date.now(), byId, list };
  return cache2;
}
async function listPairs() {
  return (await loadPairs()).list;
}
async function getPair(id) {
  const c = await loadPairs();
  const hit = c.byId.get(id);
  if (!hit) {
    const reason = BONDING_CURVE_IDS.has(id) ? `Unknown pair: ${id}` : `Unknown or excluded pair: ${id}`;
    throw Object.assign(new Error(reason), { status: 404 });
  }
  return hit;
}
async function getCurveReserves(curveId, height) {
  const info = await querySmart(curveId, { curve_info: {} }, height);
  return {
    reserve0: info.reserve || "0",
    reserve1: info.supply || "0"
  };
}
async function getPoolReserves(pairId, height) {
  const resolved = await getPair(pairId);
  if (resolved.bondingCurve || BONDING_CURVE_IDS.has(pairId)) {
    return getCurveReserves(pairId, height);
  }
  const pool = await querySmart(
    pairId,
    { pool: {} },
    height
  );
  const assets = pool.assets || [];
  const amounts = /* @__PURE__ */ new Map();
  for (const a of assets) {
    const id = assetIdFromInfo(a.info);
    if (id) amounts.set(id, a.amount || "0");
  }
  const r0 = amounts.get(resolved.pair.asset0Id) || "0";
  const r1 = amounts.get(resolved.pair.asset1Id) || "0";
  return { reserve0: r0, reserve1: r1 };
}

// src/events.ts
var JOIN_ACTIONS = /* @__PURE__ */ new Set([
  "provide_liquidity",
  "join_pool",
  "add_liquidity"
]);
var EXIT_ACTIONS = /* @__PURE__ */ new Set([
  "withdraw_liquidity",
  "exit_pool",
  "remove_liquidity"
]);
function blockFromTx(tx) {
  const blockNumber = Number(tx.height);
  const blockTimestamp = parseIsoToUnix(tx.timestamp) ?? Math.floor(Date.now() / 1e3);
  return { blockNumber, blockTimestamp };
}
function collectWasmSections(tx) {
  const out = [];
  let globalEventIndex = 0;
  const logs = tx.logs;
  if (logs && logs.length) {
    for (const log of logs) {
      const msgIndex = log.msg_index ?? 0;
      for (const ev of log.events || []) {
        if (ev.type !== "wasm" && ev.type !== "from_contract") continue;
        const sections = splitWasmSections(ev.attributes || []);
        for (const section of sections) {
          out.push({
            section,
            msgIndex,
            eventIndex: globalEventIndex++
          });
        }
      }
    }
    return out;
  }
  for (const ev of tx.events || []) {
    if (ev.type !== "wasm" && ev.type !== "from_contract") continue;
    const sections = splitWasmSections(ev.attributes || []);
    for (const section of sections) {
      const msgIndex = Number(section.msg_index || 0);
      out.push({ section, msgIndex, eventIndex: globalEventIndex++ });
    }
  }
  return out;
}
function pickMaker(section, tx) {
  return section.sender || section.receiver || section.from || (() => {
    const msgs = tx.tx?.body?.messages || [];
    for (const m of msgs) {
      if (typeof m.sender === "string") return m.sender;
    }
    return "unknown";
  })();
}
async function reservesForSwap(pair, section, siblings, height) {
  for (const s of [section, ...siblings]) {
    if (s._contract_address === pair.pair.id && s.reserve0 != null && s.reserve1 != null && s.reserve0 !== "0" && s.reserve1 !== "0") {
      return { r0Raw: s.reserve0, r1Raw: s.reserve1, source: "event" };
    }
  }
  for (const s of siblings) {
    if (s._contract_address !== pair.pair.id) continue;
    if (s.backing_after_0 && s.local_cwlunc_after) {
      return {
        r0Raw: s.backing_after_0,
        r1Raw: s.local_cwlunc_after,
        source: "rebalance_attrs"
      };
    }
  }
  try {
    const { reserve0, reserve1 } = await getPoolReserves(pair.pair.id, height);
    return {
      r0Raw: reserve0,
      r1Raw: reserve1,
      source: pair.bondingCurve ? "curve_info" : "pool_query"
    };
  } catch {
    const { reserve0, reserve1 } = await getPoolReserves(pair.pair.id);
    return {
      r0Raw: reserve0,
      r1Raw: reserve1,
      source: pair.bondingCurve ? "curve_info_tip" : "pool_query_tip"
    };
  }
}
function buildSwapEvent(opts) {
  const { pair, section, tx, txnIndex, eventIndex, r0Raw, r1Raw } = opts;
  const offerId = normalizeAssetAttr(section.offer_asset);
  const askId = normalizeAssetAttr(
    section.ask_asset || section.return_asset
  );
  const offerAmount = section.offer_amount;
  const returnAmount = section.return_amount;
  if (!offerId || !askId || !offerAmount || !returnAmount) return null;
  if (offerAmount === "0" || returnAmount === "0") return null;
  const asset0 = pair.pair.asset0Id;
  const asset1 = pair.pair.asset1Id;
  const d0 = pair.asset0Decimals;
  const d1 = pair.asset1Decimals;
  let asset0In;
  let asset1Out;
  let asset1In;
  let asset0Out;
  if (offerId === asset0 && askId === asset1) {
    asset0In = decimalize(offerAmount, d0);
    asset1Out = decimalize(returnAmount, d1);
  } else if (offerId === asset1 && askId === asset0) {
    asset1In = decimalize(offerAmount, d1);
    asset0Out = decimalize(returnAmount, d0);
  } else {
    return null;
  }
  const reserve0 = decimalize(r0Raw, d0);
  const reserve1 = decimalize(r1Raw, d1);
  if (reserve0 === "0" || reserve1 === "0") {
    return null;
  }
  const priceNative = priceNativeFromTrade({
    asset0In,
    asset1Out,
    asset1In,
    asset0Out,
    reserve0,
    reserve1
  });
  if (!priceNative || priceNative === "0") return null;
  const block = blockFromTx(tx);
  const maker = pickMaker(section, tx);
  const ev = {
    block,
    eventType: "swap",
    txnId: tx.txhash,
    txnIndex,
    eventIndex,
    maker,
    pairId: pair.pair.id,
    ...asset0In != null ? { asset0In } : {},
    ...asset1Out != null ? { asset1Out } : {},
    ...asset1In != null ? { asset1In } : {},
    ...asset0Out != null ? { asset0Out } : {},
    priceNative,
    reserves: { asset0: reserve0, asset1: reserve1 },
    metadata: {
      reserveSource: opts.reserveSource,
      offerAsset: offerId,
      askAsset: askId,
      ...pair.bondingCurve ? { bondingCurve: "true" } : {}
    }
  };
  return ev;
}
function buildJoinExit(opts) {
  const { pair, section, tx, txnIndex, eventIndex, eventType, r0Raw, r1Raw } = opts;
  let amount0Raw = section.amount0 || section.offer_amount_0;
  let amount1Raw = section.amount1 || section.offer_amount_1;
  if ((!amount0Raw || !amount1Raw) && section.assets) {
    try {
      const parsed = JSON.parse(section.assets);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        amount0Raw = parsed[0].amount || amount0Raw;
        amount1Raw = parsed[1].amount || amount1Raw;
      }
    } catch {
    }
  }
  if ((!amount0Raw || !amount1Raw) && section.refund_assets) {
    try {
      const parsed = JSON.parse(section.refund_assets);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        amount0Raw = parsed[0].amount || amount0Raw;
        amount1Raw = parsed[1].amount || amount1Raw;
      }
    } catch {
    }
  }
  if (!amount0Raw || !amount1Raw) return null;
  if (amount0Raw === "0" && amount1Raw === "0") return null;
  const reserve0 = decimalize(r0Raw, pair.asset0Decimals);
  const reserve1 = decimalize(r1Raw, pair.asset1Decimals);
  if (reserve0 === "0" || reserve1 === "0") return null;
  return {
    block: blockFromTx(tx),
    eventType,
    txnId: tx.txhash,
    txnIndex,
    eventIndex,
    maker: pickMaker(section, tx),
    pairId: pair.pair.id,
    amount0: decimalize(amount0Raw, pair.asset0Decimals),
    amount1: decimalize(amount1Raw, pair.asset1Decimals),
    reserves: { asset0: reserve0, asset1: reserve1 }
  };
}
async function parseTxForPair(pair, tx, txnIndex) {
  if (tx.code && tx.code !== 0) return [];
  const height = Number(tx.height);
  const items = collectWasmSections(tx);
  const sections = items.map((i) => i.section);
  const events = [];
  for (const item of items) {
    const { section, eventIndex } = item;
    if (section._contract_address !== pair.pair.id) continue;
    const action = (section.action || "").toLowerCase();
    if (action === "swap") {
      const { r0Raw, r1Raw, source } = await reservesForSwap(
        pair,
        section,
        sections,
        height
      );
      const ev = buildSwapEvent({
        pair,
        section,
        siblings: sections,
        tx,
        txnIndex,
        eventIndex,
        r0Raw,
        r1Raw,
        reserveSource: source
      });
      if (ev) events.push(ev);
      continue;
    }
    if (JOIN_ACTIONS.has(action) || EXIT_ACTIONS.has(action)) {
      let r0Raw = section.reserve0;
      let r1Raw = section.reserve1;
      if (!r0Raw || !r1Raw) {
        try {
          const r = await getPoolReserves(pair.pair.id, height);
          r0Raw = r.reserve0;
          r1Raw = r.reserve1;
        } catch {
          const r = await getPoolReserves(pair.pair.id);
          r0Raw = r.reserve0;
          r1Raw = r.reserve1;
        }
      }
      const ev = buildJoinExit({
        pair,
        section,
        tx,
        txnIndex,
        eventIndex,
        eventType: JOIN_ACTIONS.has(action) ? "join" : "exit",
        r0Raw,
        r1Raw
      });
      if (ev) events.push(ev);
    }
  }
  return events;
}
async function getEvents(fromBlock, toBlock) {
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
    throw Object.assign(new Error("fromBlock and toBlock are required"), {
      status: 400
    });
  }
  if (fromBlock > toBlock) {
    throw Object.assign(new Error("fromBlock must be <= toBlock"), {
      status: 400
    });
  }
  const span = toBlock - fromBlock;
  if (span > MAX_EVENTS_BLOCK_SPAN) {
    throw Object.assign(
      new Error(
        `Block span ${span} exceeds MAX_EVENTS_BLOCK_SPAN=${MAX_EVENTS_BLOCK_SPAN}`
      ),
      { status: 400 }
    );
  }
  const pairs = await listPairs();
  const all = [];
  await Promise.all(
    pairs.map(async (pair) => {
      let txs = [];
      try {
        txs = await searchTxsByContractAndHeight(
          pair.pair.id,
          fromBlock,
          toBlock,
          100
        );
      } catch (e) {
        console.warn(
          `[events] LCD search failed for ${pair.pair.id}:`,
          e.message
        );
        return;
      }
      txs.sort((a, b) => {
        const ha = Number(a.height);
        const hb = Number(b.height);
        if (ha !== hb) return ha - hb;
        return (a.txhash || "").localeCompare(b.txhash || "");
      });
      const perBlock = /* @__PURE__ */ new Map();
      for (const tx of txs) {
        const h = Number(tx.height);
        if (h < fromBlock || h > toBlock) continue;
        const txnIndex = perBlock.get(h) ?? 0;
        perBlock.set(h, txnIndex + 1);
        const evs = await parseTxForPair(pair, tx, txnIndex);
        all.push(...evs);
      }
    })
  );
  all.sort((a, b) => {
    if (a.block.blockNumber !== b.block.blockNumber) {
      return a.block.blockNumber - b.block.blockNumber;
    }
    if (a.txnIndex !== b.txnIndex) return a.txnIndex - b.txnIndex;
    return a.eventIndex - b.eventIndex;
  });
  return all;
}

// src/index.ts
var app = (0, import_express.default)();
app.use((0, import_cors.default)());
app.use(import_express.default.json());
function resolveAdapterDoc() {
  const candidates = [
    import_node_path.default.join(process.cwd(), "docs", "ADAPTER.md"),
    import_node_path.default.join(process.cwd(), "ADAPTER.md")
  ];
  for (const p of candidates) {
    if (import_node_fs.default.existsSync(p)) return p;
  }
  return null;
}
app.get("/health", async (_req, res) => {
  try {
    const block = await getLatestBlock();
    const pairs = await listPairs();
    const ammCount = pairs.filter((p) => !p.bondingCurve).length;
    const curveCount = pairs.filter((p) => p.bondingCurve).length;
    res.json({
      ok: true,
      dexKey: DEX_KEY,
      factory: FACTORY,
      router: ROUTER,
      lcd: LCD_URL,
      pairCount: pairs.length,
      ammPairCount: ammCount,
      bondingCurvePairCount: curveCount,
      latestBlock: block
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: e.message
    });
  }
});
app.get("/latest-block", async (_req, res) => {
  try {
    const { blockNumber, blockTimestamp } = await getLatestBlock();
    res.json({
      block: { blockNumber, blockTimestamp }
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.get("/asset", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) {
      res.status(400).json({ error: "Query param id is required" });
      return;
    }
    const asset = await getAsset(id);
    res.json({ asset });
  } catch (e) {
    const err = e;
    res.status(err.status || 502).json({ error: err.message });
  }
});
app.get("/pair", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) {
      res.status(400).json({ error: "Query param id is required" });
      return;
    }
    const resolved = await getPair(id);
    res.json({ pair: resolved.pair });
  } catch (e) {
    const err = e;
    res.status(err.status || 502).json({ error: err.message });
  }
});
app.get("/pairs", async (_req, res) => {
  try {
    const list = await listPairs();
    res.json({
      pairs: list.map((p) => p.pair),
      excludedPairTypes: ["token_bonding", "converter"],
      bondingCurves: BONDING_CURVES.map((c) => c.id),
      note: "token_bonding factory types are wrap vaults (excluded); product curves $WESO/$reBASE are included"
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.get("/events", async (req, res) => {
  try {
    const fromBlock = Number(req.query.fromBlock);
    const toBlock = Number(req.query.toBlock);
    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
      res.status(400).json({
        error: "fromBlock and toBlock query params are required numbers"
      });
      return;
    }
    const events = await getEvents(fromBlock, toBlock);
    res.json({ events });
  } catch (e) {
    const err = e;
    res.status(err.status || 502).json({
      error: err.message,
      maxBlockSpan: MAX_EVENTS_BLOCK_SPAN
    });
  }
});
app.get(["/docs/ADAPTER.md", "/docs/adapter.md"], (_req, res) => {
  const docPath = resolveAdapterDoc();
  if (!docPath) {
    res.status(404).type("text/plain").send("ADAPTER.md not found in deployment");
    return;
  }
  res.type("text/markdown; charset=utf-8").send(import_node_fs.default.readFileSync(docPath, "utf8"));
});
app.get("/", (_req, res) => {
  res.json({
    name: "WESO DeFi GeckoTerminal Adapter API",
    chain: "Terra Classic (columbus-5)",
    dexKey: DEX_KEY,
    factory: FACTORY,
    router: ROUTER,
    bondingCurves: BONDING_CURVES.map((c) => ({
      id: c.id,
      reserveDenom: c.reserveDenom,
      symbol: c.symbol
    })),
    endpoints: [
      "GET /health",
      "GET /latest-block",
      "GET /asset?id=",
      "GET /pair?id=",
      "GET /pairs",
      "GET /events?fromBlock=&toBlock=",
      "GET /docs/ADAPTER.md"
    ],
    docs: "/docs/ADAPTER.md"
  });
});
var index_default = app;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(
      `WESO GT adapter listening on :${PORT} (factory=${FACTORY.slice(0, 12)}\u2026 dexKey=${DEX_KEY} curves=${BONDING_CURVES.length})`
    );
  });
}

// Vercel Express expects the app as module.exports
module.exports = index_default;
