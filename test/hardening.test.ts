/**
 * Hardening (PR "harden indexing"):
 *  1. several events of one pair inside one tx -> per-event reserves (no 503)
 *  2. upstream fail-over on empty / stale / wrong-height answers, backup LCDs
 *  3. lowestAvailableBlock hint on 503 height_not_available
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DEFAULT_BACKUP_LCDS, DEFAULT_PRIMARY_LCD, resolveLcdUrls } from "../src/config.js";
import { getEvents, getLatestBlock } from "../src/events.js";
import { balanceDeltas, extractPairEvents, flattenTxEvents, intraTxReserves, type PairDef } from "../src/parse.js";
import { setPairsForTest } from "../src/pairs.js";
import { ApiError, configureUpstream, Session, type Transport, type TransportResponse } from "../src/upstream.js";
import {
  AMM_PAIR,
  ammSwap,
  type Chain,
  chainTransport,
  coins,
  CURVE,
  CURVE_PAIR,
  curveSwap,
  cw20,
  execute,
  feeEvents,
  hashOf,
  PAIR,
  TOKA,
  TOKB,
  USER,
  VAULT,
} from "./chain.js";
import { lcdTx } from "./helpers.js";

// ------------------------------------------------------------- the chain
// Block 1000: tx#0 = TWO swaps on PAIR (two messages) + a payout from the pool,
//             tx#1 = one more swap on PAIR.
const H = 1000;
const A0 = 100_000_000_000n; // TOKA in pool before block 1000
const B0 = 50_000_000_000n; // TOKB in pool before block 1000

const TX0 = {
  bytes: "multi-swap-tx",
  messages: 2,
  events: [
    ...feeEvents(),
    // msg 0: 1 TOKB -> TOKA
    execute(TOKB, 0),
    cw20(TOKB, "send", USER, PAIR, 1_000_000n, 0),
    execute(PAIR, 0),
    ammSwap(TOKB, TOKA, 1_000_000n, 1_960_000n, 20_000n, 0),
    cw20(TOKA, "transfer", PAIR, USER, 1_960_000n, 0),
    cw20(TOKB, "transfer", PAIR, VAULT, 5_000n, 0), // pool payout (reflective-style)
    // msg 1: 0.5 TOKA -> TOKB
    execute(TOKA, 1),
    cw20(TOKA, "send", USER, PAIR, 500_000n, 1),
    execute(PAIR, 1),
    ammSwap(TOKA, TOKB, 500_000n, 240_000n, 1_000n, 1),
    cw20(TOKB, "transfer", PAIR, USER, 240_000n, 1),
  ],
};
const TX1 = {
  bytes: "single-swap-tx",
  messages: 1,
  events: [
    ...feeEvents(),
    execute(TOKA, 0),
    cw20(TOKA, "send", USER, PAIR, 300_000n, 0),
    execute(PAIR, 0),
    ammSwap(TOKA, TOKB, 300_000n, 140_000n, 500n, 0),
    cw20(TOKB, "transfer", PAIR, USER, 140_000n, 0),
  ],
};

const AFTER_A = A0 - 1_960_000n + 500_000n + 300_000n;
const AFTER_B = B0 + 1_000_000n - 5_000n - 240_000n - 140_000n;

function makeChain(tip = 1100): Chain {
  return {
    tip,
    blocks: new Map([[H, [TX0, TX1]]]),
    balanceAt: (holder, asset, h) => {
      if (holder !== PAIR) return 0n;
      const after = h >= H;
      if (asset === TOKA) return after ? AFTER_A : A0;
      if (asset === TOKB) return after ? AFTER_B : B0;
      return 0n;
    },
  };
}

function use(transport: Transport, urls = ["https://a.example"]) {
  configureUpstream({ transport, urls, backoffMs: 0, attempts: 2 });
  setPairsForTest([AMM_PAIR]);
}

/** route requests by upstream base URL */
function byBase(map: Record<string, Transport>): Transport {
  return (base, pq, headers, t) => {
    const tr = map[base];
    if (!tr) throw new Error(`no transport for ${base}`);
    return tr(base, pq, headers, t);
  };
}

const isAtHeight = (h: Record<string, string>) => h["x-cosmos-block-height"] != null;
const isRangeSearch = (pq: string) => pq.startsWith("/cosmos/tx/v1beta1/txs?") && pq.includes("_contract_address");

beforeEach(() => setPairsForTest([AMM_PAIR]));

// ===================================================== 1. intra-tx reserves

const EXPECTED = [
  // tx#0 event 1: before + (+1 TOKB in, -1.96 TOKA out, -0.005 TOKB payout)
  { txnIndex: 0, asset0: "99998.04", asset1: "50000.995", in: { asset1In: "1" }, out: { asset0Out: "1.98" } },
  // tx#0 event 2: + (+0.5 TOKA in, -0.24 TOKB out)  == state after tx#0
  { txnIndex: 0, asset0: "99998.54", asset1: "50000.755", in: { asset0In: "0.5" }, out: { asset1Out: "0.241" } },
  // tx#1: + (+0.3 TOKA, -0.14 TOKB) == state at block 1000
  { txnIndex: 1, asset0: "99998.84", asset1: "50000.615", in: { asset0In: "0.3" }, out: { asset1Out: "0.1405" } },
];

test("two swaps of one pair in one tx: per-event reserves from event-ordered deltas (was 503 ambiguous_intra_tx_reserves)", async () => {
  use(chainTransport(makeChain()));
  const evs = await getEvents(H - 2, H + 2);
  assert.equal(evs.length, 3);
  evs.forEach((e, i) => {
    const x = EXPECTED[i];
    assert.equal(e.txnIndex, x.txnIndex);
    assert.deepEqual(e.reserves, { asset0: x.asset0, asset1: x.asset1 }, `reserves of event ${i}`);
    for (const [k, v] of Object.entries({ ...x.in, ...x.out })) assert.equal((e as any)[k], v, `${k} of event ${i}`);
    assert.equal(e.maker, USER);
  });
  assert.equal(evs[0].txnId, hashOf("multi-swap-tx"));
  assert.ok(evs[0].eventIndex < evs[1].eventIndex, "eventIndex increases inside the tx");
  // last event of the block == chain state at the block (exact)
  assert.deepEqual(evs[2].reserves, { asset0: "99998.84", asset1: "50000.615" });
});

test("intra-tx path is deterministic (3 calls byte-identical)", async () => {
  use(chainTransport(makeChain()));
  const a = JSON.stringify(await getEvents(H - 2, H + 2));
  assert.equal(JSON.stringify(await getEvents(H - 2, H + 2)), a);
  assert.equal(JSON.stringify(await getEvents(H - 2, H + 2)), a);
});

test("intra-tx path still enforces the block invariant: unexplained balance change -> 503", async () => {
  const chain = makeChain();
  const real = chain.balanceAt;
  chain.balanceAt = (holder, asset, h) => real(holder, asset, h) + (asset === TOKB && h >= H ? 1n : 0n);
  use(chainTransport(chain));
  await assert.rejects(getEvents(H - 2, H + 2), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.equal(e.code, "reserve_reconstruction_failed");
    return true;
  });
});

const JURIS: PairDef = {
  id: "terra14jedagazgdawpjfn37yhec5lfxs5fh22r6cl3uspa4x9yt8hnhlsp322v7",
  asset0Id: "terra1vhgq25vwuhdhn9xjll0rhl2s67jzw78a4g2t78y5kz89q9lsdskq2pxcj2",
  asset1Id: "terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6",
  asset0Decimals: 6,
  asset1Decimals: 6,
  kind: "amm",
};

test("recorded JURIS router swap D4C01235 executed twice in one tx: event 1 = before + its own deltas, event 2 = after tx", () => {
  // real mainnet event layout (router -> wrap -> cw20 send -> pair swap -> payout -> managed rebalance), message
  // duplicated as msg_index 1, i.e. the same swap signed twice in one tx
  const real = lcdTx("D4C01235B8298C7C80B1F53900237B78C3A177CE84EF0A2135DF8C1EBFFFE911");
  const msg0 = real.events!.filter((e) => e.attributes.some((a) => a.key === "msg_index" && a.value === "0"));
  const ante = real.events!.filter((e) => !e.attributes.some((a) => a.key === "msg_index"));
  const msg1 = msg0.map((e) => ({
    ...e,
    attributes: e.attributes.map((a) => (a.key === "msg_index" ? { ...a, value: "1" } : a)),
  }));
  const tx = {
    ...real,
    events: [...ante, ...msg0, ...msg1],
    tx: { body: { messages: [real.tx!.body!.messages![0], real.tx!.body!.messages![0]] } },
  };
  const flat = flattenTxEvents(tx);
  const evs = extractPairEvents(tx, JURIS, flat);
  assert.equal(evs.length, 2);
  const single = balanceDeltas(real, JURIS.id, [JURIS.asset0Id, JURIS.asset1Id]);
  const both = balanceDeltas(tx, JURIS.id, [JURIS.asset0Id, JURIS.asset1Id], flat);
  assert.equal(single.unknown.length, 0);
  assert.equal(both.deltas.length, 2 * single.deltas.length);
  const sum = (ds: typeof single.deltas, id: string) => ds.filter((d) => d.assetId === id).reduce((s, d) => s + d.amount, 0n);
  const d0 = sum(single.deltas, JURIS.asset0Id);
  const d1 = sum(single.deltas, JURIS.asset1Id);
  const before: [bigint, bigint] = [346_000_000_000_000n, 15_000_000_000_000n];
  const [r1, r2] = intraTxReserves(JURIS, before, evs, both.deltas);
  assert.deepEqual(r1, [before[0] + d0, before[1] + d1]);
  assert.deepEqual(r2, [before[0] + 2n * d0, before[1] + 2n * d1]);
  // sanity: JURIS leaves the pool; the cwLUNC offer (+231000) is outweighed by the managed rebalance send to the vault
  assert.ok(d0 < 0n);
  assert.equal(d1, 231_000_000_000n - 464_387_715_272n);
});

test("intraTxReserves: CW20 join deposits pulled AFTER the join section stay with the join; next swap's offer starts the swap", () => {
  const pair = { asset0Id: TOKA, asset1Id: TOKB };
  const before: [bigint, bigint] = [1000n, 2000n];
  const join = { eventIndex: 10 }; // CW20-only join: no trigger
  const swap = { eventIndex: 20, triggers: [{ assetId: TOKA, amount: 50n }] };
  const deltas = [
    { assetId: TOKA, amount: 100n, eventIndex: 12 }, // join TransferFrom A
    { assetId: TOKB, amount: 200n, eventIndex: 13 }, // join TransferFrom B
    { assetId: TOKA, amount: 50n, eventIndex: 18 }, // swap offer (trigger)
    { assetId: TOKB, amount: -90n, eventIndex: 22 }, // swap output
  ];
  const [rJoin, rSwap] = intraTxReserves(pair, before, [join, swap], deltas);
  assert.deepEqual(rJoin, [1100n, 2200n]);
  assert.deepEqual(rSwap, [1150n, 2110n]);
  // no visible trigger -> boundary falls back to the next event's own position
  const [j2, s2] = intraTxReserves(pair, before, [join, { eventIndex: 20 }], deltas);
  assert.deepEqual(j2, [1150n, 2200n]);
  assert.deepEqual(s2, [1150n, 2110n]);
  // input order of events does not matter
  const [sw, jn] = intraTxReserves(pair, before, [swap, join], deltas);
  assert.deepEqual([jn, sw], [rJoin, rSwap]);
});

test("intraTxReserves on a bonding curve: two buys + one sell in one tx, asset1 stays 0, native deltas incl. tax outflow", () => {
  const tx = {
    height: "5",
    txhash: "C0FFEE",
    code: 0,
    tx: { body: { messages: [0, 1, 2].map(() => ({ "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", sender: USER })) } },
    events: [
      ...feeEvents(),
      coins("coin_spent", USER, "1000000uluna", 0),
      coins("coin_received", CURVE, "1000000uluna", 0),
      execute(CURVE, 0),
      curveSwap("uluna", CURVE, 1_000_000n, 40n, 10_000n, 0),
      coins("coin_spent", CURVE, "10000uluna", 0), // project tax leaves the curve
      coins("coin_received", VAULT, "10000uluna", 0),
      coins("coin_spent", USER, "2000000uluna", 1),
      coins("coin_received", CURVE, "2000000uluna", 1),
      execute(CURVE, 1),
      curveSwap("uluna", CURVE, 2_000_000n, 79n, 20_000n, 1),
      coins("coin_spent", CURVE, "20000uluna", 1),
      coins("coin_received", VAULT, "20000uluna", 1),
      execute(CURVE, 2),
      curveSwap(CURVE, "uluna", 30n, 740_000n, 7_500n, 2),
      coins("coin_spent", CURVE, "740000uluna", 2),
      coins("coin_received", USER, "740000uluna", 2),
      coins("coin_spent", CURVE, "7500uluna", 2),
      coins("coin_received", VAULT, "7500uluna", 2),
    ],
  };
  const def = CURVE_PAIR.def;
  const flat = flattenTxEvents(tx);
  const evs = extractPairEvents(tx, def, flat);
  assert.equal(evs.length, 3);
  const { deltas, unknown } = balanceDeltas(tx, CURVE, ["uluna"], flat);
  assert.equal(unknown.length, 0);
  const res = intraTxReserves(def, [10_000_000n, 0n], evs, deltas, false);
  assert.deepEqual(res, [
    [10_990_000n, 0n],
    [12_970_000n, 0n],
    [12_222_500n, 0n],
  ]);
});

// ================================================ 2. upstream fail-over

test("default upstreams: publicnode + stakely + hexxagon; LCD_URL keeps the backups; LCD_URLS is verbatim", () => {
  assert.deepEqual(resolveLcdUrls({}), [DEFAULT_PRIMARY_LCD, ...DEFAULT_BACKUP_LCDS]);
  assert.deepEqual(resolveLcdUrls({}), [
    "https://terra-classic-lcd.publicnode.com",
    "https://terraclassic-lcd-server-01.stakely.io",
    "https://lcd.terra-classic.hexxagon.io",
  ]);
  assert.deepEqual(resolveLcdUrls({ LCD_URL: "https://terra-classic-lcd.publicnode.com/" }), [
    DEFAULT_PRIMARY_LCD,
    ...DEFAULT_BACKUP_LCDS,
  ]);
  assert.deepEqual(resolveLcdUrls({ LCD_URL: "https://my.lcd" }), ["https://my.lcd", ...DEFAULT_BACKUP_LCDS]);
  assert.deepEqual(resolveLcdUrls({ LCD_URLS: "https://x/, https://y", LCD_URL: "https://z" }), ["https://x", "https://y"]);
});

test("at-height answer echoing a DIFFERENT height is rejected and served by the next node", async () => {
  const chain = makeChain();
  const good = chainTransport(chain, { echoHeight: true });
  let mismatched = 0;
  const stuck: Transport = async (b, pq, h, t) => {
    if (isAtHeight(h)) {
      mismatched++;
      // like a stuck node: answers every at-height query from height 900 (pre-block state), says so in the header
      const r = await good(b, pq, { ...h, "x-cosmos-block-height": "900" }, t);
      return { ...r, height: "900" };
    }
    return good(b, pq, h, t);
  };
  use(byBase({ "https://a.example": stuck, "https://b.example": good }), ["https://a.example", "https://b.example"]);
  const evs = await getEvents(H - 2, H + 2);
  assert.deepEqual(
    evs.map((e) => e.reserves),
    EXPECTED.map((x) => ({ asset0: x.asset0, asset1: x.asset1 })),
  );
  assert.ok(mismatched > 0, "the stuck node was asked first");
});

test("every node answering from another height -> 503, never accepted", async () => {
  const good = chainTransport(makeChain());
  use(async (b, pq, h, t) => {
    const r = await good(b, pq, h, t);
    return isAtHeight(h) ? { ...r, height: "1" } : r;
  });
  await assert.rejects(getEvents(H - 2, H + 2), (e: unknown) => e instanceof ApiError && e.status === 503);
});

test("empty contract-query answer ({data:null}) fails over to the next node", async () => {
  const good = chainTransport(makeChain());
  let empties = 0;
  const empty: Transport = async (b, pq, h, t) => {
    if (pq.includes("/smart/")) {
      empties++;
      return { status: 200, text: '{"data":null}' };
    }
    return good(b, pq, h, t);
  };
  use(byBase({ "https://a.example": empty, "https://b.example": good }), ["https://a.example", "https://b.example"]);
  const evs = await getEvents(H - 2, H + 2);
  assert.equal(evs.length, 3);
  assert.deepEqual(evs[1].reserves, { asset0: "99998.54", asset1: "50000.755" });
  assert.ok(empties > 0);
});

test("node serving STALE state without a height header (publicnode-like): invariant fails, re-read on the next node", async () => {
  const chain = makeChain();
  const good = chainTransport(chain);
  const staleChain: Chain = { ...chain, balanceAt: (holder, asset) => chain.balanceAt(holder, asset, 0) };
  const stale = chainTransport(staleChain); // every height answered with old state, no echoed height
  use(byBase({ "https://a.example": stale, "https://b.example": good }), ["https://a.example", "https://b.example"]);
  const evs = await getEvents(H - 2, H + 2);
  assert.deepEqual(
    evs.map((e) => e.reserves),
    EXPECTED.map((x) => ({ asset0: x.asset0, asset1: x.asset1 })),
  );
});

test("stuck node (tip far behind) is ignored by /latest-block and never serves /events", async () => {
  const good = chainTransport(makeChain(1100));
  const stuckChain = makeChain(900);
  const stuckT = chainTransport(stuckChain);
  const stuckReqs: string[] = [];
  const stuck: Transport = async (b, pq, h, t) => {
    stuckReqs.push(pq);
    return stuckT(b, pq, h, t);
  };
  use(byBase({ "https://stuck.example": stuck, "https://good.example": good }), [
    "https://stuck.example",
    "https://good.example",
  ]);
  const lb = await getLatestBlock();
  assert.equal(lb.blockNumber, 1100 - 5);
  const evs = await getEvents(H - 2, H + 2);
  assert.equal(evs.length, 3);
  assert.ok(!stuckReqs.some((pq) => pq.startsWith("/cosmos/tx/v1beta1/txs")), "no tx search on the stuck node");
});

test("one backup down: /latest-block still answers from the reachable upstreams", async () => {
  const good = chainTransport(makeChain(1100));
  use(
    byBase({
      "https://a.example": good,
      "https://down.example": async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    ["https://a.example", "https://down.example"],
  );
  assert.equal((await getLatestBlock()).blockNumber, 1095);
});

test("tx search failing on the pinned node fails over ONLY to a node whose tip covers the range", async () => {
  const good = chainTransport(makeChain(1100));
  const behindT = chainTransport(makeChain(1003)); // tip 1003: does not cover toBlock 1002 + lag 5
  const behindSearches: string[] = [];
  const searchesOnC: string[] = [];
  use(
    byBase({
      "https://a.example": async (b, pq, h, t) =>
        isRangeSearch(pq) ? ({ status: 500, text: '{"code":13,"message":"boom"}' } as TransportResponse) : good(b, pq, h, t),
      "https://b.example": async (b, pq, h, t) => {
        if (pq.startsWith("/cosmos/tx/v1beta1/txs")) behindSearches.push(pq);
        return behindT(b, pq, h, t);
      },
      "https://c.example": async (b, pq, h, t) => {
        if (isRangeSearch(pq)) searchesOnC.push(pq);
        return good(b, pq, h, t);
      },
    }),
    ["https://a.example", "https://b.example", "https://c.example"],
  );
  const evs = await getEvents(H - 2, H + 2);
  assert.equal(evs.length, 3);
  assert.equal(behindSearches.length, 0, "lagging node never used for tx search");
  assert.ok(searchesOnC.length > 0, "discovery served by the covering backup");
});

test("non-height reads fail over with wrap-around and pin to the node that answered", async () => {
  const good = chainTransport(makeChain());
  let aHits = 0;
  use(
    byBase({
      "https://a.example": async () => {
        aHits++;
        return { status: 503, text: "unavailable" };
      },
      "https://b.example": good,
    }),
    ["https://a.example", "https://b.example"],
  );
  const s = new Session(["https://a.example", "https://b.example"], 1);
  assert.equal(await s.latestHeight(), 1100);
  assert.equal(aHits, 0, "started at index 1");
  const s2 = new Session(["https://a.example", "https://b.example"]);
  assert.equal(await s2.latestHeight(), 1100);
  assert.equal(s2.upstreamIndex, 1);
  aHits = 0;
  await s2.latestHeight();
  assert.equal(aHits, 0, "pinned to the node that answered");
});

// ============================================ 3. retained-history hints

test("old range: primary pruned, backup retains it -> served by the backup", async () => {
  const good = chainTransport(makeChain());
  const pruned: Transport = async (b, pq, h, t) => {
    const m = /\/blocks\/(\d+)$/.exec(pq);
    if (m && Number(m[1]) < 999) {
      return { status: 500, text: `{"code":2, "message":"height ${m[1]} is not available, lowest height is 999", "details":[]}` };
    }
    return good(b, pq, h, t);
  };
  use(byBase({ "https://a.example": pruned, "https://b.example": good }), ["https://a.example", "https://b.example"]);
  const evs = await getEvents(990, 1001);
  assert.equal(evs.length, 3);
});

test("range pruned on every upstream -> 503 height_not_available with the lowest block any node retains", async () => {
  const good = chainTransport(makeChain());
  const floorHits: Record<string, number> = {};
  const prunedAt =
    (lowest: number): Transport =>
    async (b, pq, h, t) => {
      const m = /\/blocks\/(\d+)$/.exec(pq);
      if (m && Number(m[1]) < lowest) {
        floorHits[b] = (floorHits[b] ?? 0) + 1;
        return { status: 500, text: `{"code":2, "message":"height ${m[1]} is not available, lowest height is ${lowest}", "details":[]}` };
      }
      return good(b, pq, h, t);
    };
  use(byBase({ "https://a.example": prunedAt(999), "https://b.example": prunedAt(995) }), [
    "https://a.example",
    "https://b.example",
  ]);
  await assert.rejects(getEvents(900, 1001), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.equal(e.code, "height_not_available");
    assert.equal(e.extra.lowestAvailableBlock, 995);
    return true;
  });
  // a block-store floor is definitive: asked once per node, not retried with backoff
  assert.deepEqual(floorHits, { "https://a.example": 1, "https://b.example": 1 });
});

test("at-height state pruned on every node -> 503 height_not_available (not a 502)", async () => {
  const good = chainTransport(makeChain());
  use(async (b, pq, h, t) =>
    isAtHeight(h)
      ? { status: 500, text: '{"code":2,"message":"codespace sdk code 38: not found: failed to load state at height 999"}' }
      : good(b, pq, h, t),
  );
  await assert.rejects(getEvents(H - 2, H + 2), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 503);
    assert.equal(e.code, "height_not_available");
    assert.ok(!/http|example/i.test(e.message));
    return true;
  });
});
