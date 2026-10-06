/**
 * Live smoke test against a running adapter (default http://localhost:8080).
 *   BASE_URL=https://geckoterminal-weso-adapter.vercel.app npm run smoke
 *
 * 1. /latest-block sanity
 * 2. scans back from latest-block in 2000-block chunks (max ~26 h) until a
 *    chunk with >= MIN_EVENTS events is found (fails if none)
 * 3. validates every event against GT schema rules
 * 4. /pair + /asset for every referenced id
 * 5. repeats the chunk and requires byte-identical output
 * 6. negative checks: invalid params -> 400, range above latest-block -> 400
 */
const BASE = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const SPAN = 2000;
const MAX_CHUNKS = Number(process.env.SMOKE_MAX_CHUNKS || 8); // 8 x 2000 blocks ~ 26 h at ~5.9 s/block
const MIN_EVENTS = Number(process.env.SMOKE_MIN_EVENTS || 1);

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

async function raw(path: string): Promise<{ status: number; text: string }> {
  const r = await fetch(BASE + path);
  return { status: r.status, text: await r.text() };
}
async function json(path: string): Promise<{ status: number; body: any }> {
  const r = await raw(path);
  return { status: r.status, body: JSON.parse(r.text) };
}

const DEC = /^\d+(\.\d+)?$/;

function validateEvent(e: any, pairs: Map<string, any>): void {
  const where = `${e.txnId}#${e.eventIndex}`;
  check(Number.isInteger(e.block?.blockNumber) && Number.isInteger(e.block?.blockTimestamp), `${where} block`);
  check(String(e.block?.blockTimestamp).length === 10, `${where} timestamp in seconds`);
  check(/^[0-9A-F]{64}$/.test(e.txnId), `${where} txnId`);
  check(Number.isInteger(e.txnIndex) && e.txnIndex >= 0, `${where} txnIndex`);
  check(Number.isInteger(e.eventIndex) && e.eventIndex >= 0, `${where} eventIndex`);
  check(typeof e.maker === "string" && e.maker.startsWith("terra1"), `${where} maker`);
  check(pairs.has(e.pairId), `${where} pairId listed`);
  check(DEC.test(e.reserves?.asset0) && DEC.test(e.reserves?.asset1), `${where} reserves decimal strings`);
  if (e.eventType === "swap") {
    const a = e.asset0In != null && e.asset1Out != null && e.asset1In == null && e.asset0Out == null;
    const b = e.asset1In != null && e.asset0Out != null && e.asset0In == null && e.asset1Out == null;
    check(a || b, `${where} exactly one of asset0In+asset1Out / asset1In+asset0Out`);
    for (const k of ["asset0In", "asset1In", "asset0Out", "asset1Out"]) {
      if (e[k] != null) check(DEC.test(e[k]) && Number(e[k]) > 0, `${where} ${k} positive decimal`);
    }
    check(DEC.test(e.priceNative) && /[1-9]/.test(e.priceNative), `${where} priceNative > 0`);
    check((e.priceNative.split(".")[1] ?? "").length <= 50, `${where} priceNative <= 50 dp`);
    for (const k of Object.keys(e.metadata ?? {})) {
      check(["fees0In", "fees1In", "fees0Out", "fees1Out"].includes(k), `${where} metadata key ${k}`);
    }
  } else if (e.eventType === "join" || e.eventType === "exit") {
    check(DEC.test(e.amount0) && DEC.test(e.amount1), `${where} join/exit amounts`);
  } else {
    check(false, `${where} unknown eventType ${e.eventType}`);
  }
}

async function main() {
  console.log(`smoke: ${BASE}`);
  const lb = await json("/latest-block");
  check(lb.status === 200 && Number.isInteger(lb.body?.block?.blockNumber), "/latest-block");
  const latest: number = lb.body.block.blockNumber;
  console.log(`latest-block ${latest}`);

  const pl = await json("/pairs");
  check(pl.status === 200 && pl.body.pairs.length > 0, "/pairs");
  const pairs = new Map<string, any>(pl.body.pairs.map((p: any) => [p.id, p]));

  let found: { from: number; to: number; text: string; events: any[] } | null = null;
  for (let i = 0; i < MAX_CHUNKS && !found; i++) {
    const to = latest - i * SPAN;
    const from = to - SPAN + 1;
    const r = await raw(`/events?fromBlock=${from}&toBlock=${to}`);
    check(r.status === 200, `/events ${from}-${to} status ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.status !== 200) break;
    const evs = JSON.parse(r.text).events;
    console.log(`events ${from}-${to}: ${evs.length}`);
    if (evs.length >= MIN_EVENTS) found = { from, to, text: r.text, events: evs };
  }
  check(found, `no chunk with >= ${MIN_EVENTS} events in the last ${MAX_CHUNKS * SPAN} blocks`);
  if (found) {
    const keys = new Set<string>();
    let prev = [-1, -1, -1];
    for (const e of found.events) {
      validateEvent(e, pairs);
      const k = `${e.block.blockNumber}:${e.txnIndex}:${e.eventIndex}`;
      check(!keys.has(k), `duplicate position ${k}`);
      keys.add(k);
      const cur = [e.block.blockNumber, e.txnIndex, e.eventIndex];
      check(
        cur[0] > prev[0] || (cur[0] === prev[0] && (cur[1] > prev[1] || (cur[1] === prev[1] && cur[2] > prev[2]))),
        `events sorted at ${k}`,
      );
      prev = cur;
    }
    const ids = new Set<string>();
    for (const e of found.events) ids.add(e.pairId);
    for (const id of ids) {
      const p = await json(`/pair?id=${encodeURIComponent(id)}`);
      check(p.status === 200 && p.body.pair?.name && p.body.pair.dexKey === "weso-defi", `/pair ${id}`);
      for (const a of [p.body.pair.asset0Id, p.body.pair.asset1Id]) {
        const as = await json(`/asset?id=${encodeURIComponent(a)}`);
        check(as.status === 200 && as.body.asset?.symbol && Number.isInteger(as.body.asset.decimals), `/asset ${a}`);
      }
    }
    const again = await raw(`/events?fromBlock=${found.from}&toBlock=${found.to}`);
    check(again.text === found.text, "same range twice is byte-identical");
    console.log(`validated ${found.events.length} events in ${found.from}-${found.to}`);
  }

  const bad = await json("/events?fromBlock=abc&toBlock=1");
  check(bad.status === 400, "invalid params -> 400");
  const ahead = await json(`/events?fromBlock=${latest + 1000}&toBlock=${latest + 1010}`);
  check(ahead.status === 400 && Array.isArray(ahead.body.events) === false, "range above latest-block -> 400");

  if (failures) {
    console.error(`smoke: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("smoke: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
