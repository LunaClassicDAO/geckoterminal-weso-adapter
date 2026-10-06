/**
 * Pure (network-free) parsing of Terra Classic tx responses into GT events and
 * per-pair balance deltas. Everything here is deterministic and unit tested
 * against recorded mainnet transactions.
 */
import { decimalize, ratio, toBig } from "./decimal.js";
import type { RawEvent, TxResponse } from "./upstream.js";

export interface PairDef {
  id: string;
  asset0Id: string;
  asset1Id: string;
  asset0Decimals: number;
  asset1Decimals: number;
  kind: "amm" | "curve";
}

/** One flattened event: a non-wasm event, or one contract section of a wasm event. */
export interface FlatEvent {
  type: string;
  /** first value per key */
  attrs: Record<string, string>;
  /** every `action` value, in order (sections may carry several) */
  actions: string[];
  /** raw ordered attributes (minus _contract_address) */
  raw: Array<{ key: string; value: string }>;
  contract: string | null;
  msgIndex: number | null;
  /** strictly increasing position within the tx; used as GT eventIndex */
  eventIndex: number;
}

function sectionize(ev: RawEvent): Array<{ contract: string | null; raw: Array<{ key: string; value: string }> }> {
  const out: Array<{ contract: string | null; raw: Array<{ key: string; value: string }> }> = [];
  const isWasm = ev.type === "wasm" || ev.type === "from_contract";
  let cur: { contract: string | null; raw: Array<{ key: string; value: string }> } | null = null;
  for (const a of ev.attributes || []) {
    const key = String(a.key);
    const value = String(a.value ?? "");
    if (isWasm && (key === "_contract_address" || key === "contract_address")) {
      if (cur) out.push(cur);
      cur = { contract: value, raw: [] };
      continue;
    }
    if (!cur) cur = { contract: null, raw: [] };
    cur.raw.push({ key, value });
  }
  if (cur) out.push(cur);
  if (!out.length) out.push({ contract: null, raw: [] });
  return out;
}

function toFlat(
  type: string,
  sec: { contract: string | null; raw: Array<{ key: string; value: string }> },
  fallbackMsgIndex: number | null,
  eventIndex: number,
): FlatEvent {
  const attrs: Record<string, string> = {};
  const actions: string[] = [];
  for (const { key, value } of sec.raw) {
    if (!(key in attrs)) attrs[key] = value;
    if (key === "action") actions.push(value);
  }
  let msgIndex = fallbackMsgIndex;
  if (attrs.msg_index != null && /^\d+$/.test(attrs.msg_index)) msgIndex = Number(attrs.msg_index);
  return { type, attrs, actions, raw: sec.raw, contract: sec.contract, msgIndex, eventIndex };
}

/**
 * Flatten a tx's events in execution order. Uses `tx_response.events` (SDK
 * >= 0.47, includes ante-handler events) and falls back to per-message `logs`
 * for archived txs. Each non-wasm event counts as one position; a wasm event is
 * split into one position per contract section. The resulting index is unique
 * within the tx and increases with execution order.
 */
export function flattenTxEvents(tx: TxResponse): FlatEvent[] {
  const out: FlatEvent[] = [];
  let idx = 0;
  if (tx.events && tx.events.length) {
    for (const ev of tx.events) {
      for (const sec of sectionize(ev)) out.push(toFlat(ev.type, sec, null, idx++));
    }
    return out;
  }
  (tx.logs || []).forEach((log, i) => {
    const mi = typeof log.msg_index === "number" ? log.msg_index : i;
    for (const ev of log.events || []) {
      for (const sec of sectionize(ev)) out.push(toFlat(ev.type, sec, mi, idx++));
    }
  });
  return out;
}

/** Signer / original sender of message `msgIndex` (unwraps authz MsgExec). */
export function makerOf(tx: TxResponse, msgIndex: number | null): string | null {
  const msgs = tx.tx?.body?.messages || [];
  if (!msgs.length) return null;
  const m = (msgIndex != null ? msgs[msgIndex] : null) ?? (msgs.length === 1 || msgIndex == null ? msgs[0] : null);
  if (!m) return null;
  const type = String(m["@type"] || "");
  if (type.endsWith("authz.v1beta1.MsgExec")) {
    const inner = (m["msgs"] as Array<Record<string, unknown>> | undefined) || [];
    for (const im of inner) {
      const s = im["sender"] ?? im["from_address"] ?? im["delegator_address"];
      if (typeof s === "string" && s) return s;
    }
    const g = m["grantee"];
    return typeof g === "string" && g ? g : null;
  }
  const s = m["sender"] ?? m["from_address"];
  return typeof s === "string" && s ? s : null;
}

export function normalizeAssetAttr(raw: string | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (typeof j?.native === "string") return j.native;
      if (typeof j?.native_token?.denom === "string") return j.native_token.denom;
      if (typeof j?.cw20 === "string") return j.cw20;
      if (typeof j?.token?.contract_addr === "string") return j.token.contract_addr;
    } catch {
      /* fallthrough */
    }
    return null;
  }
  return s;
}

/**
 * Parse a TerraSwap-style asset list: "123uluna, 456terra1abc..." (also accepts
 * a JSON array of {info, amount}). Returns amount per asset id.
 */
export function parseAssetList(raw: string | undefined): Map<string, bigint> | null {
  if (raw == null) return null;
  const s = raw.trim();
  const out = new Map<string, bigint>();
  if (!s) return out;
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s) as Array<{ info?: unknown; amount?: string }>;
      for (const a of arr) {
        const info = a.info as { native_token?: { denom?: string }; token?: { contract_addr?: string } } | undefined;
        const id = info?.native_token?.denom ?? info?.token?.contract_addr;
        if (!id || typeof a.amount !== "string") return null;
        out.set(id, (out.get(id) ?? 0n) + toBig(a.amount));
      }
      return out;
    } catch {
      return null;
    }
  }
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)([a-zA-Z][a-zA-Z0-9/:._-]*)$/.exec(p);
    if (!m) return null;
    out.set(m[2], (out.get(m[2]) ?? 0n) + BigInt(m[1]));
  }
  return out;
}

/** "123uluna,45uusd" -> Map(denom -> amount) */
export function parseCoins(raw: string | undefined): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)([a-zA-Z][a-zA-Z0-9/:._-]*)$/.exec(p);
    if (!m) throw new Error(`unparseable coin amount ${JSON.stringify(p)}`);
    out.set(m[2], (out.get(m[2]) ?? 0n) + BigInt(m[1]));
  }
  return out;
}

const big = (v: string | undefined): bigint => (v == null || v === "" ? 0n : toBig(v));

/** Event without reserves (reserves are attached by the orchestrator). */
export interface ParsedEvent {
  pairId: string;
  eventType: "swap" | "join" | "exit";
  txnId: string;
  eventIndex: number;
  msgIndex: number | null;
  maker: string;
  // raw integer amounts
  asset0In?: bigint;
  asset1In?: bigint;
  asset0Out?: bigint;
  asset1Out?: bigint;
  fees0In?: bigint;
  fees1In?: bigint;
  fees0Out?: bigint;
  fees1Out?: bigint;
  amount0?: bigint;
  amount1?: bigint;
  /** priceNative (asset1 per asset0) computed exactly from curve amounts */
  priceNative?: string;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Swap amounts per GT spec (assetIn = what the pool receives from the user,
 * assetOut = curve output, fees split into feesIn / feesOut, Scenarios A/B):
 *
 *  - Factory AMM pairs: assetIn = offer_amount (no input-side fee);
 *    assetOut = return + commission + tax_amount + chancla_tax_amount (the
 *    gross curve output, == `vg` on reflective pairs); feesOut = commission +
 *    tax_amount + chancla_tax_amount.
 *  - cw20_bonding curve BUY (offer = native): the user sends offer_amount,
 *    tax_amount is taken from it before the curve -> asset0In = offer,
 *    fees0In = tax; asset1Out = return_amount (minted to the buyer).
 *  - cw20_bonding curve SELL (burn): asset1In = offer (burned);
 *    curve releases return + tax -> asset0Out = return + tax, fees0Out = tax.
 *
 * priceNative = asset1 / asset0 of the amounts that went through the curve
 * (input after feesIn, output before feesOut), truncated to 50 decimals.
 */
export function extractPairEvents(tx: TxResponse, pair: PairDef, flat?: FlatEvent[]): ParsedEvent[] {
  if (tx.code != null && tx.code !== 0) return [];
  const events = flat ?? flattenTxEvents(tx);
  const out: ParsedEvent[] = [];
  for (const ev of events) {
    if (ev.type !== "wasm" || ev.contract !== pair.id) continue;
    const a = ev.attrs;
    const isSwap = ev.actions.includes("swap") && a.offer_asset != null && a.offer_amount != null;
    const isJoin = ev.actions[0] === "provide_liquidity";
    const isExit = ev.actions[0] === "withdraw_liquidity";
    if (!isSwap && !isJoin && !isExit) continue;

    const maker = makerOf(tx, ev.msgIndex);
    if (!maker) throw new ParseError(`cannot determine maker for ${tx.txhash}`);
    const base = { pairId: pair.id, txnId: tx.txhash, eventIndex: ev.eventIndex, msgIndex: ev.msgIndex, maker };

    if (isSwap) {
      const offerId = normalizeAssetAttr(a.offer_asset);
      const askId = normalizeAssetAttr(a.ask_asset);
      const offer = big(a.offer_amount);
      const ret = big(a.return_amount);
      const tax = big(a.tax_amount);
      let pe: ParsedEvent;
      if (pair.kind === "curve") {
        if (offerId === pair.asset0Id && askId === pair.asset1Id) {
          // buy: native in, curve token out
          if (tax > offer) throw new ParseError(`curve tax > offer in ${tx.txhash}`);
          pe = { ...base, eventType: "swap", asset0In: offer, asset1Out: ret };
          if (tax > 0n) pe.fees0In = tax;
          pe.priceNative = price(ret, pair.asset1Decimals, offer - tax, pair.asset0Decimals) ?? undefined;
        } else if (offerId === pair.asset1Id && askId === pair.asset0Id) {
          // sell (burn): curve token in, native out
          const gross = ret + tax;
          pe = { ...base, eventType: "swap", asset1In: offer, asset0Out: gross };
          if (tax > 0n) pe.fees0Out = tax;
          pe.priceNative = price(offer, pair.asset1Decimals, gross, pair.asset0Decimals) ?? undefined;
        } else {
          throw new ParseError(`curve swap with unexpected assets in ${tx.txhash}`);
        }
      } else {
        const commission = big(a.commission_amount ?? a.commission);
        const chancla = big(a.chancla_tax_amount);
        const feesOut = commission + tax + chancla;
        const gross = ret + feesOut;
        if (a.vg != null && toBig(a.vg) !== gross) {
          throw new ParseError(`swap gross output mismatch (vg) in ${tx.txhash}`);
        }
        if (offerId === pair.asset0Id && askId === pair.asset1Id) {
          pe = { ...base, eventType: "swap", asset0In: offer, asset1Out: gross };
          if (feesOut > 0n) pe.fees1Out = feesOut;
          pe.priceNative = price(gross, pair.asset1Decimals, offer, pair.asset0Decimals) ?? undefined;
        } else if (offerId === pair.asset1Id && askId === pair.asset0Id) {
          pe = { ...base, eventType: "swap", asset1In: offer, asset0Out: gross };
          if (feesOut > 0n) pe.fees0Out = feesOut;
          pe.priceNative = price(offer, pair.asset1Decimals, gross, pair.asset0Decimals) ?? undefined;
        } else {
          throw new ParseError(`swap with unexpected assets in ${tx.txhash}`);
        }
      }
      if (pe.priceNative === undefined) continue; // zero-amount swap: see price()
      out.push(pe);
      continue;
    }

    if (isJoin) {
      const assets = parseAssetList(a.assets);
      const refund = parseAssetList(a.refund_assets ?? "") ?? new Map<string, bigint>();
      if (!assets) throw new ParseError(`unparseable provide_liquidity assets in ${tx.txhash}`);
      checkIds(assets, pair, tx);
      checkIds(refund, pair, tx);
      const amount0 = (assets.get(pair.asset0Id) ?? 0n) - (refund.get(pair.asset0Id) ?? 0n);
      const amount1 = (assets.get(pair.asset1Id) ?? 0n) - (refund.get(pair.asset1Id) ?? 0n);
      if (amount0 < 0n || amount1 < 0n) throw new ParseError(`negative join amount in ${tx.txhash}`);
      out.push({ ...base, eventType: "join", amount0, amount1 });
      continue;
    }

    // exit
    const refund = parseAssetList(a.refund_assets);
    if (!refund) throw new ParseError(`unparseable withdraw_liquidity refund_assets in ${tx.txhash}`);
    checkIds(refund, pair, tx);
    out.push({
      ...base,
      eventType: "exit",
      amount0: refund.get(pair.asset0Id) ?? 0n,
      amount1: refund.get(pair.asset1Id) ?? 0n,
    });
  }
  return out;
}

function checkIds(m: Map<string, bigint>, pair: PairDef, tx: TxResponse): void {
  for (const id of m.keys()) {
    if (id !== pair.asset0Id && id !== pair.asset1Id) {
      throw new ParseError(`liquidity event references foreign asset in ${tx.txhash}`);
    }
  }
}

/**
 * Exact price or null when either side is zero. A swap that moves zero of one
 * asset cannot be represented for GT (priceNative=0 halts indexing; a made-up
 * price would be wrong), so such events are omitted. Any balance change they
 * caused is still reflected in the reserves of the next event on that pair.
 */
function price(num: bigint, numDec: number, den: bigint, denDec: number): string | null {
  if (num <= 0n || den <= 0n) return null;
  const p = ratio(num, numDec, den, denDec, 50);
  return p == null || p === "0" ? null : p;
}

// ------------------------------------------------------------ balance deltas

export interface Delta {
  assetId: string;
  amount: bigint; // signed
  eventIndex: number;
}

/**
 * Every balance change of `address` for the given asset ids that is visible in
 * the tx's events. `unknown` lists positions where the address is mentioned by
 * an asset contract with an action we cannot account for (callers must then
 * refuse to reconstruct reserves from deltas).
 */
export function balanceDeltas(
  tx: TxResponse,
  address: string,
  assetIds: string[],
  flat?: FlatEvent[],
): { deltas: Delta[]; unknown: number[] } {
  const deltas: Delta[] = [];
  const unknown: number[] = [];
  if (tx.code != null && tx.code !== 0) return { deltas, unknown };
  const natives = new Set(assetIds.filter((id) => !id.startsWith("terra1")));
  const tokens = new Set(assetIds.filter((id) => id.startsWith("terra1")));
  for (const ev of flat ?? flattenTxEvents(tx)) {
    if (ev.type === "coin_received" || ev.type === "coin_spent") {
      const who = ev.type === "coin_received" ? ev.attrs.receiver : ev.attrs.spender;
      if (who !== address) continue;
      const sign = ev.type === "coin_received" ? 1n : -1n;
      for (const [denom, amt] of parseCoins(ev.attrs.amount)) {
        if (natives.has(denom)) deltas.push({ assetId: denom, amount: sign * amt, eventIndex: ev.eventIndex });
      }
      continue;
    }
    if (ev.type !== "wasm" || !ev.contract || !tokens.has(ev.contract)) continue;
    const mentions = ev.raw.some((r) => r.value === address);
    if (!mentions) continue;
    const act = ev.actions[0];
    const a = ev.attrs;
    const amt = a.amount != null && /^\d+$/.test(a.amount) ? BigInt(a.amount) : null;
    let handled = false;
    if (amt != null && ["transfer", "send", "transfer_from", "send_from"].includes(act)) {
      if (a.from === address) deltas.push({ assetId: ev.contract, amount: -amt, eventIndex: ev.eventIndex });
      if (a.to === address) deltas.push({ assetId: ev.contract, amount: amt, eventIndex: ev.eventIndex });
      handled = a.from === address || a.to === address || a.by === address;
    } else if (amt != null && (act === "burn" || act === "burn_from")) {
      if (a.from === address) deltas.push({ assetId: ev.contract, amount: -amt, eventIndex: ev.eventIndex });
      handled = a.from === address || a.by === address;
    } else if (amt != null && act === "mint") {
      if (a.to === address) deltas.push({ assetId: ev.contract, amount: amt, eventIndex: ev.eventIndex });
      handled = a.to === address;
    } else if (act === "increase_allowance" || act === "decrease_allowance") {
      handled = true; // no balance change
    }
    if (!handled) unknown.push(ev.eventIndex);
  }
  return { deltas, unknown };
}

/** True if any attribute of any event in the tx equals `address`. */
export function txMentions(tx: TxResponse, address: string, flat?: FlatEvent[]): boolean {
  if (tx.code != null && tx.code !== 0) return false;
  for (const ev of flat ?? flattenTxEvents(tx)) {
    if (ev.contract === address) return true;
    for (const r of ev.raw) if (r.value === address) return true;
  }
  return false;
}

// --------------------------------------------------------------- rendering

export function renderAmount(v: bigint | undefined, decimals: number): string | undefined {
  return v == null ? undefined : decimalize(v, decimals);
}
