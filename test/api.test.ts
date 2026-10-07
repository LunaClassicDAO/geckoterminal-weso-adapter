/** HTTP layer: status codes, error bodies, asset/pair endpoints (replayed mainnet data). */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { clearAssetCacheForTest } from "../src/assets.js";
import { setPairsForTest } from "../src/pairs.js";
import { configureUpstream } from "../src/upstream.js";
import { fixtureJson, loadRecording, replayTransport } from "./helpers.js";

process.env.NODE_ENV = "test";
const { default: app } = await import("../src/index.js");

let base = "";
let server: import("node:http").Server;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

beforeEach(() => {
  configureUpstream({ transport: replayTransport(loadRecording("curve-buy-sell")), urls: ["https://lcd.example"], backoffMs: 0, attempts: 2 });
  setPairsForTest(null);
  clearAssetCacheForTest();
});

async function get(path: string) {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
}

test("GET /events returns the verified events", async () => {
  const exp = fixtureJson("expected/curve-buy-sell.json");
  const r = await get("/events?fromBlock=30710200&toBlock=30710310");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { events: exp.events });
});

test("GET /events with invalid params -> 400 JSON", async () => {
  for (const q of ["", "?fromBlock=1", "?fromBlock=a&toBlock=2", "?fromBlock=-5&toBlock=2", "?fromBlock=1.5&toBlock=2", "?fromBlock=1&fromBlock=2&toBlock=3", "?fromBlock=5&toBlock=4"]) {
    const r = await get("/events" + q);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, "invalid_params", q);
  }
  const big = await get("/events?fromBlock=1&toBlock=2001");
  assert.equal(big.status, 400);
  assert.equal(big.body.code, "range_too_large");
});

test("upstream failure -> 5xx JSON without upstream URLs or bodies", async () => {
  configureUpstream({
    transport: async () => {
      throw new Error("getaddrinfo ENOTFOUND does-not-exist.invalid (https://does-not-exist.invalid)");
    },
    urls: ["https://does-not-exist.invalid"],
    backoffMs: 0,
    attempts: 2,
  });
  for (const p of ["/events?fromBlock=30710200&toBlock=30710310", "/latest-block", "/pair?id=uluna", "/asset?id=uluna", "/health"]) {
    const r = await get(p);
    assert.ok(r.status >= 500, `${p} -> ${r.status}`);
    const s = JSON.stringify(r.body);
    assert.ok(!/https?:|invalid|ENOTFOUND|lcd/i.test(s), `${p} leaked: ${s}`);
    assert.ok(!("events" in r.body));
  }
});

test("GET /asset: CW20 data verbatim from token_info; natives with CoinGecko ids; no made-up assets", async () => {
  const cw = await get("/asset?id=terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6");
  assert.equal(cw.status, 200);
  assert.equal(cw.body.asset.name, "LUNC (cw20)");
  assert.equal(cw.body.asset.symbol, "cwLUNC");
  assert.equal(cw.body.asset.decimals, 6);
  assert.equal(cw.body.asset.coinGeckoId, undefined);

  const lunc = await get("/asset?id=uluna");
  assert.deepEqual(
    { s: lunc.body.asset.symbol, d: lunc.body.asset.decimals, cg: lunc.body.asset.coinGeckoId },
    { s: "LUNC", d: 6, cg: "terra-luna" },
  );

  const ibc = await get("/asset?id=ibc/0471F1C4E7AFD3F07702BEF6DC365268D64570F7C1FDC98EA6098DD6DE59817B");
  assert.equal(ibc.status, 404);
  const unknown = await get("/asset?id=terra1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq");
  assert.equal(unknown.status, 404);
  const missing = await get("/asset");
  assert.equal(missing.status, 400);
});

test("GET /pair: curve feeBps from on-chain project_tax_pct, AMM feeBps from commission_rate", async () => {
  const weso = await get("/pair?id=terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms");
  assert.equal(weso.status, 200);
  assert.equal(weso.body.pair.feeBps, 100);
  assert.equal(weso.body.pair.name, "LUNC/WESO");
  assert.equal(weso.body.pair.asset0Id, "uluna");
  const juris = await get("/pair?id=terra14jedagazgdawpjfn37yhec5lfxs5fh22r6cl3uspa4x9yt8hnhlsp322v7");
  assert.equal(juris.body.pair.feeBps, 20);
  assert.equal(juris.body.pair.name, "JURIS/cwLUNC");
  const vault = await get("/pair?id=terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6");
  assert.equal(vault.status, 404, "wrap vault (token_bonding) is excluded");
});

test("misconfigured upstream answering 4xx HTML -> 502 upstream_bad_response, nothing leaked", async () => {
  configureUpstream({
    transport: async () => ({ status: 404, text: "<!doctype html><title>Example Domain</title> https://wrong-host.example" }),
    urls: ["https://wrong-host.example"],
    backoffMs: 0,
    attempts: 2,
  });
  for (const p of ["/events?fromBlock=30710200&toBlock=30710310", "/latest-block", "/pair?id=uluna", "/asset?id=uluna", "/health"]) {
    const r = await get(p);
    assert.equal(r.status, 502, p);
    assert.ok(["upstream_bad_response", "upstream_unavailable"].includes(r.body.code), `${p} ${r.body.code}`);
    assert.ok(!/https?:|wrong-host|doctype/i.test(JSON.stringify(r.body)), p);
  }
});
