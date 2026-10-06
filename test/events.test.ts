/**
 * End-to-end /events logic replayed against RECORDED mainnet upstream
 * responses (test/fixtures/upstream/*.json.gz, captured by
 * scripts/record-fixtures.ts). Expected outputs in test/fixtures/expected/
 * were cross-checked against the independent reference rebuild
 * (see fix-verification notes in the PR).
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getEvents, getLatestBlock, parseRange, txHashFromBase64 } from "../src/events.js";
import { setPairsForTest } from "../src/pairs.js";
import { ApiError, configureUpstream, Session, type Transport } from "../src/upstream.js";
import { fixtureJson, keyOf, loadRecording, replayTransport, type Recording } from "./helpers.js";

const SCENARIOS = ["curve-buy-sell", "juris-router", "juris-chancla", "juris-big-block", "empty-range"];

function use(transport: Transport, urls = ["https://lcd.example"]) {
  configureUpstream({ transport, urls, backoffMs: 0, attempts: 3 });
  setPairsForTest(null);
}

beforeEach(() => {
  setPairsForTest(null);
});

for (const name of SCENARIOS) {
  test(`replay ${name}: output equals the verified expected events, 3 calls byte-identical`, async () => {
    const exp = fixtureJson(`expected/${name}.json`);
    use(replayTransport(loadRecording(name)));
    const outs: string[] = [];
    for (let i = 0; i < 3; i++) outs.push(JSON.stringify(await getEvents(exp.from, exp.to)));
    assert.equal(outs[1], outs[0]);
    assert.equal(outs[2], outs[0]);
    assert.deepEqual(JSON.parse(outs[0]), exp.events);
  });
}

test("curve reserves: asset0 = bank balance at the event height, asset1 = 0 (nothing pooled)", async () => {
  const rec = loadRecording("curve-buy-sell");
  use(replayTransport(rec));
  const evs = await getEvents(30710200, 30710310);
  const sell = evs.find((e) => e.txnId.startsWith("746A91D1"))!;
  const bal = JSON.parse(
    rec[
      "/cosmos/bank/v1beta1/balances/terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms/by_denom?denom=uluna&height=30710307|height=30710307"
    ].text,
  );
  assert.equal(bal.balance.amount, "334995820198658");
  assert.deepEqual(sell.reserves, { asset0: "334995820.198658", asset1: "0" });
});

test("txnIndex is the real index in the block (D4C01235 is tx #5 of block 30706085)", async () => {
  const rec = loadRecording("juris-router");
  const blk = JSON.parse(rec["/cosmos/base/tendermint/v1beta1/blocks/30706085"].text);
  const hashes: string[] = blk.block.data.txs.map(txHashFromBase64);
  assert.equal(hashes.indexOf("D4C01235B8298C7C80B1F53900237B78C3A177CE84EF0A2135DF8C1EBFFFE911"), 5);
  use(replayTransport(rec));
  const [ev] = await getEvents(30706080, 30706090);
  assert.equal(ev.txnIndex, 5);
});

test("JURIS reserves after the full tx (post payout) at txIndex 84/87: 15868182.834228 cwLUNC", async () => {
  use(replayTransport(loadRecording("juris-big-block")));
  const [ev] = await getEvents(30694741, 30694741);
  assert.equal(ev.txnIndex, 84);
  assert.deepEqual(ev.reserves, { asset0: "346767352.541905", asset1: "15868182.834228" });
});

test("transient 5xx on at-height queries are retried; result identical (never tip fallback)", async () => {
  const rec = loadRecording("curve-buy-sell");
  const exp = fixtureJson("expected/curve-buy-sell.json");
  const seen = new Map<string, number>();
  const tipQueries: string[] = [];
  const inner = replayTransport(rec);
  use(async (base, pq, headers, t) => {
    const k = keyOf(pq, headers);
    if (headers["x-cosmos-block-height"] == null && /balances|smart/.test(pq) && /height=/.test(pq)) tipQueries.push(k);
    if (headers["x-cosmos-block-height"] != null) {
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n <= 2) return { status: 500, text: '{"code":2,"message":"transient"}' };
    }
    return inner(base, pq, headers, t);
  });
  const evs = await getEvents(exp.from, exp.to);
  assert.deepEqual(evs, exp.events);
  assert.equal(tipQueries.length, 0);
  assert.ok([...seen.values()].every((n) => n === 3));
});

test("at-height query failing on every retry -> 502 for the whole request (no partial/tip data)", async () => {
  const rec = loadRecording("curve-buy-sell");
  const inner = replayTransport(rec);
  use(async (base, pq, headers, t) => {
    if (headers["x-cosmos-block-height"] != null) return { status: 500, text: "boom http://secret-upstream" };
    return inner(base, pq, headers, t);
  });
  await assert.rejects(getEvents(30710200, 30710310), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 502);
    assert.ok(!/http|secret/i.test(e.message));
    return true;
  });
});

test("fail-over: first upstream down, second serves -> same output, pinned to second", async () => {
  const rec = loadRecording("juris-router");
  const exp = fixtureJson("expected/juris-router.json");
  const inner = replayTransport(rec);
  let badHits = 0;
  use(
    async (base, pq, headers, t) => {
      if (base === "https://bad.example") {
        badHits++;
        throw new Error("ECONNREFUSED");
      }
      return inner(base, pq, headers, t);
    },
    ["https://bad.example", "https://good.example"],
  );
  assert.deepEqual(await getEvents(exp.from, exp.to), exp.events);
  assert.ok(badHits > 0);
});

test("all upstreams down -> 502, never an empty 200", async () => {
  use(async () => {
    throw new Error("getaddrinfo ENOTFOUND bad-lcd.invalid");
  });
  await assert.rejects(getEvents(30710200, 30710310), (e: unknown) => e instanceof ApiError && e.status === 502);
  await assert.rejects(getLatestBlock(), (e: unknown) => e instanceof ApiError && e.status === 502);
});

test("range below the node's oldest retained block -> 503 with lowestAvailableBlock", async () => {
  const rec: Recording = { ...loadRecording("empty-range") };
  // real mainnet response captured from the LCD (HTTP 500, gRPC code 2)
  rec["/cosmos/base/tendermint/v1beta1/blocks/30000000"] = {
    status: 500,
    text: '{"code":2, "message":"height 30000000 is not available, lowest height is 30522054", "details":[]}',
  };
  use(replayTransport(rec));
  await assert.rejects(getEvents(30000000, 30000010), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.equal(e.code, "height_not_available");
    assert.equal(e.extra.lowestAvailableBlock, 30522054);
    return true;
  });
});

test("block retained but its txs not in the tx index (pruned index) -> 503, never a short/empty 200", async () => {
  // mainnet 2026-10-05: block 30522054 was served (1 tx) while tx search for it returned total 0
  const rec: Recording = { ...loadRecording("curve-buy-sell") };
  const probeKey = Object.keys(rec).find((k) => k.startsWith("/cosmos/tx/v1beta1/txs?query=tx.height%3D30710200") && k.includes("limit=1"))!;
  assert.ok(probeKey, "probe request recorded");
  rec[probeKey] = { status: 200, text: '{"pagination":null,"total":"0","tx_responses":[],"txs":[]}' };
  use(replayTransport(rec));
  await assert.rejects(getEvents(30710200, 30710310), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.equal(e.code, "height_not_available");
    return true;
  });
});

test("toBlock beyond the latest available block -> 400 (not an empty 200)", async () => {
  const rec = loadRecording("empty-range");
  const tip = Number(JSON.parse(rec["/cosmos/base/tendermint/v1beta1/blocks/latest"].text).block.header.height);
  use(replayTransport(rec));
  await assert.rejects(getEvents(tip - 5, tip), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 400);
    assert.equal(e.code, "range_not_available");
    return true;
  });
});

test("balance change not explained by events -> 503 instead of guessing reserves", async () => {
  const rec: Recording = { ...loadRecording("curve-buy-sell") };
  const k =
    "/cosmos/bank/v1beta1/balances/terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms/by_denom?denom=uluna&height=30710306|height=30710306";
  const body = JSON.parse(rec[k].text);
  body.balance.amount = String(BigInt(body.balance.amount) + 1n);
  rec[k] = { status: 200, text: JSON.stringify(body) };
  use(replayTransport(rec));
  await assert.rejects(getEvents(30710200, 30710310), (e: unknown) => e instanceof ApiError && e.status === 503);
});

// Observed on mainnet (publicnode, 2026-10-05): some backends intermittently
// ignore x-cosmos-block-height and answer HTTP 200 with TIP state. The
// per-block invariant detects it and the balances are re-read.
const TIP_STATE = '{"balance":{"denom":"uluna","amount":"334992729011480"}}'; // real tip value seen that day

test("backend answering at-height query with tip state: detected by invariant, re-read, exact output", async () => {
  const rec = loadRecording("curve-buy-sell");
  const exp = fixtureJson("expected/curve-buy-sell.json");
  const inner = replayTransport(rec);
  const seen = new Map<string, number>();
  use(async (base, pq, headers, t) => {
    if (headers["x-cosmos-block-height"] != null && pq.includes("/by_denom")) {
      const k = keyOf(pq, headers);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n === 1) return { status: 200, text: TIP_STATE };
    }
    return inner(base, pq, headers, t);
  });
  const out = await getEvents(exp.from, exp.to);
  assert.deepEqual(out, exp.events);
  assert.ok([...seen.values()].some((n) => n >= 2), "balances were re-read");
});

test("backend persistently answering with tip state -> 503, tip state never reported", async () => {
  const rec = loadRecording("curve-buy-sell");
  const inner = replayTransport(rec);
  use(async (base, pq, headers, t) => {
    if (headers["x-cosmos-block-height"] === "30710306" && pq.includes("/by_denom")) return { status: 200, text: TIP_STATE };
    return inner(base, pq, headers, t);
  });
  await assert.rejects(getEvents(30710200, 30710310), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.equal(e.code, "reserve_reconstruction_failed");
    return true;
  });
});

test("tx search total/page inconsistencies -> 503", async () => {
  const rec: Recording = { ...loadRecording("juris-router") };
  const key = Object.keys(rec).find((k) => k.startsWith("/cosmos/tx/v1beta1/txs?") && k.includes("terra14jed"))!;
  const body = JSON.parse(rec[key].text);
  body.total = String(Number(body.total) + 1); // claims one more tx than delivered
  rec[key] = { status: 200, text: JSON.stringify(body) };
  // page 2 then answers like the real LCD does for an out-of-range page
  rec[key.replace("page=1", "page=2")] = {
    status: 500,
    text: '{"code":13, "message":"failed to search for txs: page should be within [1, 1] range, given 2", "details":[]}',
  };
  use(replayTransport(rec));
  await assert.rejects(getEvents(30706080, 30706090), (e: unknown) => e instanceof ApiError && e.status >= 500);
});

test("searchTxsAll walks every page in ascending order (no 100 cap)", async () => {
  const mk = (i: number) => ({ height: String(1000 + i), txhash: `H${String(i).padStart(4, "0")}`, code: 0 });
  const all = Array.from({ length: 250 }, (_, i) => mk(i));
  const pages: number[] = [];
  use(async (_b, pq) => {
    const u = new URL("http://x" + pq);
    assert.equal(u.searchParams.get("order_by"), "ORDER_BY_ASC");
    assert.equal(u.searchParams.get("limit"), "100");
    const page = Number(u.searchParams.get("page"));
    pages.push(page);
    return { status: 200, text: JSON.stringify({ tx_responses: all.slice((page - 1) * 100, page * 100), total: "250" }) };
  });
  const got = await new Session().searchTxsAll("q");
  assert.equal(got.length, 250);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(
    got.map((t) => t.txhash),
    all.map((t) => t.txhash),
  );

  // short page -> 503
  use(async (_b, pq) => {
    const page = Number(new URL("http://x" + pq).searchParams.get("page"));
    return { status: 200, text: JSON.stringify({ tx_responses: page === 1 ? all.slice(0, 100) : [], total: "250" }) };
  });
  await assert.rejects(new Session().searchTxsAll("q"), (e: unknown) => e instanceof ApiError && e.status === 503);

  // duplicate across pages -> 503
  use(async (_b, pq) => {
    const page = Number(new URL("http://x" + pq).searchParams.get("page"));
    return { status: 200, text: JSON.stringify({ tx_responses: page === 1 ? all.slice(0, 100) : all.slice(99, 150), total: "150" }) };
  });
  await assert.rejects(new Session().searchTxsAll("q"), (e: unknown) => e instanceof ApiError && e.status === 503);
});

test("/latest-block = min of tip samples across upstreams minus lag, timestamp from that block", async () => {
  const tips: Record<string, number[]> = { "https://a": [1000, 999, 1001], "https://b": [998, 1002, 1000] };
  use(
    async (base, pq) => {
      if (pq.endsWith("/blocks/latest")) {
        const h = tips[base].shift()!;
        return { status: 200, text: JSON.stringify({ block: { header: { height: String(h), time: "2026-10-05T00:00:00Z" } } }) };
      }
      const m = /\/blocks\/(\d+)$/.exec(pq)!;
      return {
        status: 200,
        text: JSON.stringify({ block: { header: { height: m[1], time: "2026-10-05T01:02:03.456Z" }, data: { txs: [] } } }),
      };
    },
    ["https://a", "https://b"],
  );
  const b = await getLatestBlock();
  assert.deepEqual(b, { blockNumber: 998 - 5, blockTimestamp: Math.floor(Date.parse("2026-10-05T01:02:03Z") / 1000) });
});

test("parseRange rejects anything but strict non-negative integers", () => {
  const bad: Array<[unknown, unknown]> = [
    ["abc", "10"],
    ["-1", "10"],
    ["1.5", "10"],
    ["1e3", "2000"],
    ["0x10", "20"],
    [" 1", "2"],
    ["01", "2"],
    ["", "2"],
    [undefined, "2"],
    [["1", "2"], "3"],
    ["10", "9"],
    ["0", "5"],
    ["1", "2001"], // 2001 blocks > MAX_EVENTS_BLOCK_SPAN (2000)
    ["99999999999999999999", "99999999999999999999"],
  ];
  for (const [f, t] of bad) {
    assert.throws(
      () => parseRange(f, t),
      (e: unknown) => e instanceof ApiError && e.status === 400,
      `expected 400 for ${JSON.stringify([f, t])}`,
    );
  }
  assert.deepEqual(parseRange("1", "2000"), { fromBlock: 1, toBlock: 2000 });
  assert.deepEqual(parseRange("30710200", "30710200"), { fromBlock: 30710200, toBlock: 30710200 });
});
