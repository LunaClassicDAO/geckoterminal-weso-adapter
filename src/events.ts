import { createHash } from "node:crypto";
import {
  LATEST_BLOCK_LAG,
  LATEST_BLOCK_SAMPLES,
  MAX_EVENTS_BLOCK_SPAN,
  RESERVE_CONSISTENCY_ATTEMPTS,
  TX_INDEX_PROBES,
  UPSTREAM_CONCURRENCY,
  UPSTREAM_MAX_TIP_LAG,
} from "./config.js";
import { decimalize } from "./decimal.js";
import {
  balanceDeltas,
  extractPairEvents,
  flattenTxEvents,
  intraTxReserves,
  txMentions,
  type Delta,
  type FlatEvent,
  type PairDef,
  type ParsedEvent,
  ParseError,
} from "./parse.js";
import { listPairs } from "./pairs.js";
import type { Block, IndexedEvent } from "./types.js";
import { ApiError, backoff, blockTimestamp, getUpstreamUrls, Session, type TxResponse } from "./upstream.js";

// ------------------------------------------------------------------ helpers

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed: unknown = null;
  async function worker() {
    while (failed == null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = failed ?? e;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed != null) throw failed;
  return out;
}

export function txHashFromBase64(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").toUpperCase();
}

const STRICT_UINT = /^(0|[1-9]\d*)$/;

/** Validate the raw query params of /events. Throws ApiError(400) on anything but two strict non-negative integers. */
export function parseRange(fromRaw: unknown, toRaw: unknown): { fromBlock: number; toBlock: number } {
  if (typeof fromRaw !== "string" || typeof toRaw !== "string") {
    throw new ApiError(400, "invalid_params", "fromBlock and toBlock are required, each exactly once");
  }
  if (!STRICT_UINT.test(fromRaw) || !STRICT_UINT.test(toRaw)) {
    throw new ApiError(400, "invalid_params", "fromBlock and toBlock must be non-negative integers");
  }
  const fromBlock = Number(fromRaw);
  const toBlock = Number(toRaw);
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock)) {
    throw new ApiError(400, "invalid_params", "fromBlock and toBlock are out of range");
  }
  if (fromBlock < 1) throw new ApiError(400, "invalid_params", "fromBlock must be >= 1");
  if (fromBlock > toBlock) throw new ApiError(400, "invalid_params", "fromBlock must be <= toBlock");
  if (toBlock - fromBlock + 1 > MAX_EVENTS_BLOCK_SPAN) {
    throw new ApiError(
      400,
      "range_too_large",
      `At most ${MAX_EVENTS_BLOCK_SPAN} blocks per request (toBlock - fromBlock + 1)`,
      { maxBlockSpan: MAX_EVENTS_BLOCK_SPAN },
    );
  }
  return { fromBlock, toBlock };
}

// ------------------------------------------------------------- latest block

async function minTip(s: Session, samples: number): Promise<number> {
  let m = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) m = Math.min(m, await s.latestHeight());
  return m;
}

/**
 * Tip of every configured upstream (min of `samples` reads each), in parallel.
 * Unreachable upstreams are null; upstreams more than UPSTREAM_MAX_TIP_LAG
 * blocks behind the highest tip are reported as stale.
 */
export async function upstreamTips(samples: number): Promise<{ tips: Array<number | null>; stale: boolean[]; lastErr: unknown }> {
  const urls = getUpstreamUrls();
  let lastErr: unknown = null;
  const tips = await Promise.all(
    urls.map(async (url, i) => {
      try {
        return await minTip(new Session([url]), samples);
      } catch (e) {
        lastErr = e;
        console.warn(`[latest-block] upstream #${i} unavailable`);
        return null;
      }
    }),
  );
  const ok = tips.filter((t): t is number => t != null);
  const max = ok.length ? Math.max(...ok) : 0;
  const stale = tips.map((t) => t == null || max - t > UPSTREAM_MAX_TIP_LAG);
  return { tips, stale, lastErr };
}

/**
 * Lagged latest block: min over LATEST_BLOCK_SAMPLES tip samples on every
 * reachable, non-stale upstream, minus LATEST_BLOCK_LAG. A single unreachable
 * or stuck backup cannot freeze indexing; if NO upstream answers the request
 * fails (5xx) so GT retries instead of advancing on partial information.
 */
export async function getLatestBlock(): Promise<Block> {
  const { tips, stale, lastErr } = await upstreamTips(LATEST_BLOCK_SAMPLES);
  const healthy = tips.filter((t, i): t is number => t != null && !stale[i]);
  if (!healthy.length) {
    throw lastErr ?? new ApiError(502, "upstream_unavailable", "Upstream node request failed after retries");
  }
  const height = Math.min(...healthy) - LATEST_BLOCK_LAG;
  if (!Number.isSafeInteger(height) || height < 1) {
    throw new ApiError(502, "upstream_bad_response", "Upstream returned an invalid chain height");
  }
  const blk = await new Session().block(height);
  return { blockNumber: height, blockTimestamp: blockTimestamp(blk) };
}

// ------------------------------------------------------------------- events

interface BlockCtx {
  height: number;
  timestamp: number;
  /** canonical tx list of the block, in block order */
  txs: TxResponse[];
  flats: FlatEvent[][];
  indexByHash: Map<string, number>;
}

async function loadBlock(s: Session, height: number): Promise<BlockCtx> {
  const [blk, searched] = await Promise.all([s.block(height), s.searchTxsAll(`tx.height=${height}`)]);
  const raw = blk.block?.data?.txs ?? [];
  const hashes = raw.map(txHashFromBase64);
  const indexByHash = new Map<string, number>();
  hashes.forEach((h, i) => indexByHash.set(h, i));
  if (indexByHash.size !== hashes.length || searched.length !== hashes.length) {
    throw new ApiError(503, "upstream_inconsistent", `Tx index for block ${height} is incomplete`);
  }
  const ordered = new Array<TxResponse>(hashes.length);
  for (const tx of searched) {
    const i = indexByHash.get(String(tx.txhash).toUpperCase());
    if (i == null || Number(tx.height) !== height || ordered[i]) {
      throw new ApiError(503, "upstream_inconsistent", `Tx index for block ${height} does not match block contents`);
    }
    ordered[i] = tx;
  }
  return {
    height,
    timestamp: blockTimestamp(blk),
    txs: ordered,
    flats: ordered.map((t) => flattenTxEvents(t)),
    indexByHash,
  };
}

type Balances = [bigint, bigint];

async function balancesAt(s: Session, pair: PairDef, height: number): Promise<Balances> {
  const one = async (assetId: string, isAsset1: boolean): Promise<bigint> => {
    if (pair.kind === "curve" && isAsset1) return 0n; // nothing pooled; see README "Bonding-curve reserves"
    if (assetId.startsWith("terra1")) return s.cw20Balance(assetId, pair.id, height);
    return s.bankBalance(pair.id, assetId, height);
  };
  return Promise.all([one(pair.asset0Id, false), one(pair.asset1Id, true)]) as Promise<Balances>;
}

function trackedAssets(pair: PairDef): string[] {
  return pair.kind === "curve" ? [pair.asset0Id] : [pair.asset0Id, pair.asset1Id];
}

function sumDeltas(
  tx: TxResponse,
  flat: FlatEvent[],
  pair: PairDef,
): { d0: bigint; d1: bigint; ok: boolean; deltas: Delta[] } {
  const { deltas, unknown } = balanceDeltas(tx, pair.id, trackedAssets(pair), flat);
  let d0 = 0n;
  let d1 = 0n;
  for (const d of deltas) {
    if (d.assetId === pair.asset0Id) d0 += d.amount;
    else if (d.assetId === pair.asset1Id) d1 += d.amount;
  }
  return { d0, d1, ok: unknown.length === 0, deltas };
}

/**
 * Reserves after each event of `pair` in block `ctx`:
 *  - state at height h is the pool state after the LAST tx of the block that
 *    touches the pair, so the state after any tx T is state(h) minus the
 *    balance deltas of the later touching txs;
 *  - a tx with one event of the pair gets exactly the state after that tx;
 *  - a tx with several events of the pair starts from the state before the tx
 *    and applies its balance deltas in event-position order (intraTxReserves);
 *    the last event of the tx again equals the state after the tx.
 * Invariant enforced on every call: state(h-1) + all evented deltas of the
 * block == state(h). A mismatch is re-read on the next upstream
 * (RESERVE_CONSISTENCY_ATTEMPTS) since some LCD backends intermittently answer
 * at-height queries with tip / stale state. If it still does not hold (a
 * balance changed without events) the request fails with 503 instead of
 * guessing. Never uses tip state.
 */
async function reservesForBlock(
  s: Session,
  pair: PairDef,
  ctx: BlockCtx,
  events: Array<{ ev: ParsedEvent; txIndex: number }>,
): Promise<Map<ParsedEvent, Balances>> {
  const touching: Array<{ idx: number; d0: bigint; d1: bigint; ok: boolean; deltas: Delta[] }> = [];
  ctx.txs.forEach((tx, idx) => {
    if (txMentions(tx, pair.id, ctx.flats[idx])) touching.push({ idx, ...sumDeltas(tx, ctx.flats[idx], pair) });
  });
  if (!touching.every((t) => t.ok)) {
    throw new ApiError(
      503,
      "reserve_reconstruction_failed",
      `Block ${ctx.height} contains a pool balance change that cannot be attributed; refusing to report reserves`,
    );
  }
  let e0 = 0n;
  let e1 = 0n;
  for (const t of touching) {
    e0 += t.d0;
    e1 += t.d1;
  }
  const curveAsset1Untracked = pair.kind === "curve";
  let after: Balances | null = null;
  for (let attempt = 1; attempt <= RESERVE_CONSISTENCY_ATTEMPTS; attempt++) {
    const [a, b] = await Promise.all([balancesAt(s, pair, ctx.height), balancesAt(s, pair, ctx.height - 1)]);
    if (b[0] + e0 === a[0] && (curveAsset1Untracked || b[1] + e1 === a[1])) {
      after = a;
      break;
    }
    console.warn(`[reserves] invariant mismatch for ${pair.id} @${ctx.height} (attempt ${attempt}); re-reading on next upstream`);
    s.rotateHeightReads();
    if (attempt < RESERVE_CONSISTENCY_ATTEMPTS) await backoff(attempt);
  }
  if (after == null) {
    throw new ApiError(
      503,
      "reserve_reconstruction_failed",
      `Pool balance changes in block ${ctx.height} are not fully explained by events; refusing to report reserves`,
    );
  }

  /** pool state right after the whole tx `txIndex` */
  const afterTx = (txIndex: number): Balances => {
    let r0 = after![0];
    let r1 = after![1];
    for (const t of touching) {
      if (t.idx > txIndex) {
        r0 -= t.d0;
        if (!curveAsset1Untracked) r1 -= t.d1;
      }
    }
    return [r0, r1];
  };

  const byTx = new Map<number, ParsedEvent[]>();
  for (const { ev, txIndex } of events) {
    const arr = byTx.get(txIndex) ?? [];
    arr.push(ev);
    byTx.set(txIndex, arr);
  }
  const out = new Map<ParsedEvent, Balances>();
  for (const [txIndex, evs] of byTx) {
    const end = afterTx(txIndex);
    let per: Balances[];
    if (evs.length === 1) {
      per = [end];
    } else {
      const t = touching.find((x) => x.idx === txIndex);
      const d0 = t?.d0 ?? 0n;
      const d1 = curveAsset1Untracked ? 0n : (t?.d1 ?? 0n);
      const before: Balances = [end[0] - d0, end[1] - d1];
      per = intraTxReserves(pair, before, evs, t?.deltas ?? [], !curveAsset1Untracked);
      const last = per[evs.reduce((bi, e, i) => (e.eventIndex > evs[bi].eventIndex ? i : bi), 0)];
      if (last[0] !== end[0] || last[1] !== end[1]) {
        throw new ApiError(503, "reserve_reconstruction_failed", `Intra-tx reserves do not add up in block ${ctx.height}`);
      }
    }
    evs.forEach((ev, i) => {
      const [r0, r1] = per[i];
      if (r0 < 0n || r1 < 0n) {
        throw new ApiError(503, "reserve_reconstruction_failed", `Negative reconstructed reserve in block ${ctx.height}`);
      }
      out.set(ev, [r0, r1]);
    });
  }
  return out;
}

function render(pair: PairDef, ctx: BlockCtx, txIndex: number, ev: ParsedEvent, res: Balances): IndexedEvent {
  const d0 = pair.asset0Decimals;
  const d1 = pair.asset1Decimals;
  const head = {
    block: { blockNumber: ctx.height, blockTimestamp: ctx.timestamp },
    eventType: ev.eventType,
    txnId: ev.txnId,
    txnIndex: txIndex,
    eventIndex: ev.eventIndex,
    maker: ev.maker,
    pairId: pair.id,
  };
  const reserves = { asset0: decimalize(res[0], d0), asset1: decimalize(res[1], d1) };
  if (ev.eventType === "swap") {
    const o: Record<string, unknown> = { ...head };
    if (ev.asset0In != null) o.asset0In = decimalize(ev.asset0In, d0);
    if (ev.asset1In != null) o.asset1In = decimalize(ev.asset1In, d1);
    if (ev.asset0Out != null) o.asset0Out = decimalize(ev.asset0Out, d0);
    if (ev.asset1Out != null) o.asset1Out = decimalize(ev.asset1Out, d1);
    o.priceNative = ev.priceNative;
    o.reserves = reserves;
    const meta: Record<string, string> = {};
    if (ev.fees0In != null) meta.fees0In = decimalize(ev.fees0In, d0);
    if (ev.fees1In != null) meta.fees1In = decimalize(ev.fees1In, d1);
    if (ev.fees0Out != null) meta.fees0Out = decimalize(ev.fees0Out, d0);
    if (ev.fees1Out != null) meta.fees1Out = decimalize(ev.fees1Out, d1);
    if (Object.keys(meta).length) o.metadata = meta;
    return o as unknown as IndexedEvent;
  }
  return {
    ...head,
    eventType: ev.eventType,
    amount0: decimalize(ev.amount0 ?? 0n, d0),
    amount1: decimalize(ev.amount1 ?? 0n, d1),
    reserves,
  } as IndexedEvent;
}

/**
 * Indices of the upstreams whose tip covers `toBlock` (tip - LATEST_BLOCK_LAG >=
 * toBlock), in configured order. Throws 400 if no upstream has the range yet.
 */
async function upstreamsCovering(toBlock: number): Promise<number[]> {
  const urls = getUpstreamUrls();
  let best = -1;
  let lastErr: unknown = null;
  const covering: number[] = [];
  const tips = await Promise.all(
    urls.map(async (url) => {
      try {
        return await minTip(new Session([url]), 2);
      } catch (e) {
        lastErr = e;
        return null;
      }
    }),
  );
  tips.forEach((tip, i) => {
    if (tip == null) return;
    best = Math.max(best, tip);
    // same safety lag as /latest-block: a load-balanced backend lagging a few
    // blocks behind must not be able to silently omit txs from tx search
    if (toBlock <= tip - LATEST_BLOCK_LAG) covering.push(i);
  });
  if (best < 0) throw lastErr ?? new ApiError(502, "upstream_unavailable", "Upstream node request failed after retries");
  if (!covering.length) {
    throw new ApiError(
      400,
      "range_not_available",
      "toBlock is beyond the latest block available to /events; poll /latest-block first",
      { latestBlock: best - LATEST_BLOCK_LAG },
    );
  }
  return covering;
}

/**
 * Pinned session for the range: the first covering upstream that also retains
 * the range's blocks and tx index (so a backup with deeper history serves old
 * ranges). Throws 503 height_not_available (with lowestAvailableBlock = the
 * lowest block any upstream retains, when known) if none does.
 */
async function sessionForRange(fromBlock: number, toBlock: number): Promise<Session> {
  const urls = getUpstreamUrls();
  const covering = await upstreamsCovering(toBlock);
  let firstErr: ApiError | null = null;
  let otherErr: unknown = null;
  let lowest: number | null = null;
  let allReported = true;
  for (const i of covering) {
    try {
      await assertRangeRetained(new Session([urls[i]]), fromBlock, toBlock);
    } catch (e) {
      if (e instanceof ApiError && e.code === "height_not_available") {
        firstErr = firstErr ?? e;
        const l = e.extra.lowestAvailableBlock;
        if (typeof l === "number") lowest = lowest == null ? l : Math.min(lowest, l);
        else allReported = false;
        console.warn(`[events] upstream #${i} does not retain ${fromBlock}-${toBlock}; trying next`);
        continue;
      }
      if (e instanceof ApiError && e.status >= 500) {
        otherErr = otherErr ?? e;
        console.warn(`[events] upstream #${i} failed the retention probe (${e.code}); trying next`);
        continue;
      }
      throw e;
    }
    const s = new Session(urls, i);
    s.requireTip(toBlock + LATEST_BLOCK_LAG, i);
    return s;
  }
  if (!firstErr) throw otherErr;
  const err = firstErr;
  // hint only when every upstream reported its oldest block (a pruned tx index has no reported floor)
  throw new ApiError(err.status, err.code, err.message, lowest != null && allReported ? { lowestAvailableBlock: lowest } : {});
}

/**
 * The range must be fully retained by the upstream: fromBlock must exist in the
 * block store (else 503 height_not_available from s.block) AND the tx index must
 * cover it. Pruning is bottom-up, so it suffices to check the first block >=
 * fromBlock that contains txs: its indexed tx count must equal its real count.
 * Blocks before it are empty, so nothing there can be missed.
 */
const MAX_EMPTY_PROBE_BLOCKS = 50;
async function assertRangeRetained(s: Session, fromBlock: number, toBlock: number): Promise<void> {
  for (let h = fromBlock; h <= toBlock && h < fromBlock + MAX_EMPTY_PROBE_BLOCKS; h++) {
    const blk = await s.block(h);
    const n = (blk.block?.data?.txs ?? []).length;
    if (n === 0) continue;
    for (let i = 0; i < TX_INDEX_PROBES; i++) {
      if ((await s.txCount(`tx.height=${h}`)) !== n) {
        throw new ApiError(
          503,
          "height_not_available",
          `Transactions of block ${h} are not (fully) indexed by the upstream node; the range is below its retained tx history`,
        );
      }
    }
    return;
  }
  if (toBlock >= fromBlock + MAX_EMPTY_PROBE_BLOCKS) {
    throw new ApiError(503, "upstream_inconsistent", `No transactions in blocks ${fromBlock}+; cannot verify tx index retention`);
  }
}

export async function getEvents(fromBlock: number, toBlock: number): Promise<IndexedEvent[]> {
  const pairs = (await listPairs()).map((p) => p.def);
  const s = await sessionForRange(fromBlock, toBlock);

  // 1. discovery: every tx that executed a pair contract in the range (all pages)
  const found = await mapLimit(pairs, UPSTREAM_CONCURRENCY, (p) =>
    s.searchTxsAll(`tx.height>=${fromBlock} AND tx.height<=${toBlock} AND wasm._contract_address='${p.id}'`),
  );
  const discovered = new Map<string, TxResponse>();
  for (const list of found) {
    for (const tx of list) {
      const h = Number(tx.height);
      if (h < fromBlock || h > toBlock) {
        throw new ApiError(503, "upstream_inconsistent", "Upstream tx search returned a tx outside the range");
      }
      discovered.set(String(tx.txhash).toUpperCase(), tx);
    }
  }
  const heights = new Set<number>();
  const discoveredWithEvents = new Set<string>();
  for (const [hash, tx] of discovered) {
    if (tx.code != null && tx.code !== 0) continue;
    const flat = flattenTxEvents(tx);
    for (const p of pairs) {
      if (extractWithErrors(tx, p, flat).length) {
        heights.add(Number(tx.height));
        discoveredWithEvents.add(hash);
      }
    }
  }

  // 2. per block: canonical tx order, events, reserves
  const sortedHeights = [...heights].sort((a, b) => a - b);
  const perBlock = await mapLimit(sortedHeights, UPSTREAM_CONCURRENCY, async (h) => {
    const ctx = await loadBlock(s, h);
    const byPair = new Map<string, Array<{ ev: ParsedEvent; txIndex: number }>>();
    ctx.txs.forEach((tx, txIndex) => {
      for (const p of pairs) {
        for (const ev of extractWithErrors(tx, p, ctx.flats[txIndex])) {
          if (!discoveredWithEvents.has(String(tx.txhash).toUpperCase())) {
            throw new ApiError(503, "upstream_inconsistent", "Tx search missed a pair transaction");
          }
          const arr = byPair.get(p.id) ?? [];
          arr.push({ ev, txIndex });
          byPair.set(p.id, arr);
        }
      }
    });
    const rendered: IndexedEvent[] = [];
    for (const p of pairs) {
      const evs = byPair.get(p.id);
      if (!evs) continue;
      const res = await reservesForBlock(s, p, ctx, evs);
      for (const { ev, txIndex } of evs) rendered.push(render(p, ctx, txIndex, ev, res.get(ev)!));
    }
    return rendered;
  });

  const all = perBlock.flat();
  all.sort(
    (a, b) =>
      a.block.blockNumber - b.block.blockNumber || a.txnIndex - b.txnIndex || a.eventIndex - b.eventIndex,
  );
  const keys = new Set<string>();
  for (const e of all) {
    const k = `${e.block.blockNumber}:${e.txnIndex}:${e.eventIndex}`;
    if (keys.has(k)) throw new ApiError(500, "internal_error", "Duplicate event position");
    keys.add(k);
  }
  return all;
}

function extractWithErrors(tx: TxResponse, p: PairDef, flat: FlatEvent[]): ParsedEvent[] {
  try {
    return extractPairEvents(tx, p, flat);
  } catch (e) {
    if (e instanceof ParseError) {
      throw new ApiError(500, "unparseable_event", `Unrecognised event format in tx ${tx.txhash}`);
    }
    throw e;
  }
}
