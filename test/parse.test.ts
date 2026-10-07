/**
 * Parser tests against REAL recorded transactions:
 *  - test/fixtures/lcd/*.json : LCD GetTx responses (mainnet, retained history)
 *  - test/fixtures/fcd/*.json : FCD archive txs older than the LCD's retained
 *    history (join/exit and reBASE fixtures; no join/exit exists in retained
 *    history for any listed pair)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balanceDeltas,
  extractPairEvents,
  flattenTxEvents,
  makerOf,
  parseAssetList,
  type PairDef,
} from "../src/parse.js";
import { fcdTx, lcdTx } from "./helpers.js";

const CW = "terra10fusc7487y4ju2v5uavkauf3jdpxx9h8sc7wsqdqg4rne8t4qyrq8385q6";
const ROUTER = "terra1nynrxdccq0r9ghrz0sq7tjkkh8wug0ggg4lkzsags8r9dyhf7ypqx5gsr8";
const WESO: PairDef = {
  id: "terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms",
  asset0Id: "uluna",
  asset1Id: "terra13ryrrlcskwa05cd94h54c8rnztff9l82pp0zqnfvlwt77za8wjjsld36ms",
  asset0Decimals: 6,
  asset1Decimals: 6,
  kind: "curve",
};
const REBASE: PairDef = {
  id: "terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m",
  asset0Id: "uusd",
  asset1Id: "terra1uewxz67jhhhs2tj97pfm2egtk7zqxuhenm4y4m",
  asset0Decimals: 6,
  asset1Decimals: 6,
  kind: "curve",
};
const JURIS: PairDef = {
  id: "terra14jedagazgdawpjfn37yhec5lfxs5fh22r6cl3uspa4x9yt8hnhlsp322v7",
  asset0Id: "terra1vhgq25vwuhdhn9xjll0rhl2s67jzw78a4g2t78y5kz89q9lsdskq2pxcj2",
  asset1Id: CW,
  asset0Decimals: 6,
  asset1Decimals: 6,
  kind: "amm",
};
const MDOT: PairDef = {
  id: "terra16587457f3s5edwg9d4my5udv0ezq9vguy6p295xfm9yfhqch7ksq5kr4v6",
  asset0Id: "terra19ya4jpvjvvtggepvmmj6ftmwly3p7way0tt08r",
  asset1Id: CW,
  asset0Decimals: 6,
  asset1Decimals: 6,
  kind: "amm",
};
const ASTRO: PairDef = {
  id: "terra1udqrxagr6tu0snr89hcyntj3zm0tjra3pslalsvyq6aczmr7aqtsfyyv48",
  asset0Id: "terra1xj49zyqrwpv5k928jwfpfy2ha668nwdgkwlrg3",
  asset1Id: CW,
  asset0Decimals: 6,
  asset1Decimals: 6,
  kind: "amm",
};
const ALL = [WESO, REBASE, JURIS, MDOT, ASTRO];

function only<T>(arr: T[]): T {
  assert.equal(arr.length, 1, `expected exactly one event, got ${arr.length}`);
  return arr[0];
}

test("eventIndex: strictly increasing and unique in every fixture tx", () => {
  const txs = [
    "72983185E1B2C06330A238D723B802A40C647FBFB6D092B604F479A197109C6D",
    "746A91D1EC0FB16BD06528389D32E7CBBBC402513D62FBB8FB97BAF48C840556",
    "C90E0A5E5AB5DE219633540BA444574545D01D8A914E016F27189AB52833376F",
    "D4C01235B8298C7C80B1F53900237B78C3A177CE84EF0A2135DF8C1EBFFFE911",
    "6CC4CBD6729B27AB8CD01546A7B0E06013AE3CFD83949CE4DB2731E625D71D9F",
    "E72D9D3AA059E55CB10B7FB2797C409C1B9B1D481F7E596A4EB4F79068554765",
  ].map(lcdTx);
  for (const tx of txs) {
    const flat = flattenTxEvents(tx);
    flat.forEach((f, i) => assert.equal(f.eventIndex, i));
    // and across all pairs within the tx, (txnId, eventIndex) is unique
    const idx = ALL.flatMap((p) => extractPairEvents(tx, p, flat)).map((e) => e.eventIndex);
    assert.equal(new Set(idx).size, idx.length);
  }
});

test("curve BUY 72983185 (block 30710210): gross in + fees0In, priceNative on net input", () => {
  const tx = lcdTx("72983185E1B2C06330A238D723B802A40C647FBFB6D092B604F479A197109C6D");
  const ev = only(extractPairEvents(tx, WESO));
  assert.equal(ev.eventType, "swap");
  assert.equal(ev.asset0In, 11895131788n);
  assert.equal(ev.fees0In, 117761804n);
  assert.equal(ev.asset1Out, 298663437n);
  assert.equal(ev.asset1In, undefined);
  assert.equal(ev.asset0Out, undefined);
  assert.equal(ev.priceNative, "0.02535909438234049793098526809429985552876386565593");
  assert.equal(ev.maker, "terra17qfdg4k5mdgat2a3ydg6kfj5u6uxcw85gkglwc");
  assert.equal(ev.eventIndex, 12);
  // what actually moved: curve received offer, paid tax back out -> net offer - tax
  const { deltas, unknown } = balanceDeltas(tx, WESO.id, ["uluna"]);
  assert.deepEqual(unknown, []);
  assert.equal(deltas.reduce((a, d) => a + d.amount, 0n), 11895131788n - 117761804n);
  const outflow = -deltas.filter((d) => d.amount < 0n).reduce((a, d) => a + d.amount, 0n);
  assert.equal(outflow, ev.fees0In, "tax_amount is exactly what left the curve");
});

test("curve SELL/burn 746A91D1 (block 30710307): asset0Out = return + tax, fees0Out = tax", () => {
  const tx = lcdTx("746A91D1EC0FB16BD06528389D32E7CBBBC402513D62FBB8FB97BAF48C840556");
  const ev = only(extractPairEvents(tx, WESO));
  assert.equal(ev.asset1In, 498514332n);
  assert.equal(ev.asset0Out, 19428515724n + 31135441n);
  assert.equal(ev.fees0Out, 31135441n);
  assert.equal(ev.priceNative, "0.02561784524157476077757840938152294982313471496394");
  assert.equal(ev.maker, "terra1uyz8jh7c6uemlduxey527zcs48qudr7ssqca96");
  assert.equal(ev.eventIndex, 9);
  const { deltas } = balanceDeltas(tx, WESO.id, ["uluna"]);
  assert.equal(deltas.reduce((a, d) => a + d.amount, 0n), -(19428515724n + 31135441n));
});

test("reBASE curve buy 2C7ABF66 (FCD archive, block 29858204) uses uusd reserve", () => {
  const tx = fcdTx("2C7ABF66D50E2B0E5652C520C7F9A9A1D7B85CFA882DAACD9B5C9C97BCCA5DA5");
  const ev = only(extractPairEvents(tx, REBASE));
  assert.equal(ev.asset0In, 3500000000n);
  assert.equal(ev.fees0In, 33950000n);
  assert.equal(ev.asset1Out, 7419484119n);
  assert.equal(ev.priceNative, "2.14061658631583502834638854026918249880988445059938");
  assert.equal(ev.maker, "terra1mqr4x5hgdcqkcymzr7td2zpqq5epjcej00zd90");
  assert.equal(extractPairEvents(tx, WESO).length, 0);
});

test("reBASE curve burn AC5B7FCD (FCD archive, block 30154484)", () => {
  const tx = fcdTx("AC5B7FCD43E9225121E6FE21ACDD0FE318549CFD7CF81907DA0A29744CC45065");
  const ev = only(extractPairEvents(tx, REBASE));
  assert.equal(ev.asset1In, 13110111455n);
  assert.equal(ev.asset0Out, 5582256722n + 56386431n);
  assert.equal(ev.fees0Out, 56386431n);
  assert.equal(ev.maker, "terra1fnytfnzmuwrp7ughe3tu0uh05mc06ce9sh23aa");
  // the curve's uusd outflow is exactly return + tax
  const { deltas } = balanceDeltas(tx, REBASE.id, ["uusd"]);
  assert.equal(deltas.reduce((a, d) => a + d.amount, 0n), -(5582256722n + 56386431n));
});

test("JURIS direct swap C90E0A5E: gross out == vg, fees1Out = commission + chancla", () => {
  const tx = lcdTx("C90E0A5E5AB5DE219633540BA444574545D01D8A914E016F27189AB52833376F");
  const ev = only(extractPairEvents(tx, JURIS));
  assert.equal(ev.asset0In, 5000000000000n);
  assert.equal(ev.asset1Out, 225398450461n); // == vg attribute
  assert.equal(ev.fees1Out, 450796901n + 11247382678n);
  assert.equal(ev.priceNative, "0.0450796900922");
  assert.equal(ev.maker, "terra18ghfdxm524jlkrthg54ttu68elfp7jpwx5at96");
  // pool flows over the FULL tx (vault hydration in, return + commission out)
  const { deltas, unknown } = balanceDeltas(tx, JURIS.id, [JURIS.asset0Id, CW]);
  assert.deepEqual(unknown, []);
  const sum = (id: string) => deltas.filter((d) => d.assetId === id).reduce((a, d) => a + d.amount, 0n);
  assert.equal(sum(JURIS.asset0Id), 5000000000000n);
  assert.equal(sum(CW), 439769052805n - 213700270882n - 450796901n);
});

test("JURIS swap routed through the router D4C01235: maker is the signer, not the router", () => {
  const tx = lcdTx("D4C01235B8298C7C80B1F53900237B78C3A177CE84EF0A2135DF8C1EBFFFE911");
  const ev = only(extractPairEvents(tx, JURIS));
  assert.equal(ev.maker, "terra1c00fgal7ftntug608e27l37n3z2gldp0xfgeuh");
  assert.notEqual(ev.maker, ROUTER);
  assert.equal(ev.asset1In, 231000000000n);
  assert.equal(ev.asset0Out, 5147058775776n + 10314747046n);
  assert.equal(ev.fees0Out, 10314747046n);
  assert.equal(ev.eventIndex, 23);
});

test("JURIS swap E72D9D3A (txIndex 84 of 87)", () => {
  const tx = lcdTx("E72D9D3AA059E55CB10B7FB2797C409C1B9B1D481F7E596A4EB4F79068554765");
  const ev = only(extractPairEvents(tx, JURIS));
  assert.equal(ev.asset1In, 1036712002009n);
  assert.equal(ev.asset0Out, 23025625431115n + 46143537939n);
  assert.equal(ev.maker, "terra12jlsn34ampqfwcvhtsp2z0hjl3jur9s5yel90g");
});

test("multi-message router tx 6CC4CBD6 through excluded wrap vault/converter yields no events", () => {
  const tx = lcdTx("6CC4CBD6729B27AB8CD01546A7B0E06013AE3CFD83949CE4DB2731E625D71D9F");
  for (const p of ALL) assert.equal(extractPairEvents(tx, p).length, 0);
  // maker resolution respects msg_index (message 1 is a different contract)
  assert.equal(makerOf(tx, 1), "terra1qdwhhs7uzavcqctazp06ay7dw0jzcfap6ejg6s");
});

test("JOIN mDOT 2349C3CD (FCD archive, block 28479690): TerraSwap-style assets string", () => {
  const tx = fcdTx("2349C3CD6A0FBCBB5B82F0129BF337BFFF6219FC7627806BF60D0D2D41E8A484");
  const ev = only(extractPairEvents(tx, MDOT));
  assert.equal(ev.eventType, "join");
  assert.equal(ev.amount0, 106465604543n);
  assert.equal(ev.amount1, 36728932099n);
  assert.equal(ev.maker, "terra1r2u8em5304u25xy0xw5ds7f40rcjqdd3e6pk06");
  const { deltas, unknown } = balanceDeltas(tx, MDOT.id, [MDOT.asset0Id, CW]);
  assert.deepEqual(unknown, []);
  assert.deepEqual(
    deltas.map((d) => [d.assetId, d.amount]),
    [
      [MDOT.asset0Id, 106465604543n],
      [CW, 36728932099n],
    ],
  );
});

test("JOIN ASTRO BED1C000 (FCD archive, block 29556679): provide in message #2 of 3", () => {
  const tx = fcdTx("BED1C00007E13C4F11699325F3BDAFFAB2D168269A1963FF9D65D9CABD1EEBBB");
  const ev = only(extractPairEvents(tx, ASTRO));
  assert.equal(ev.eventType, "join");
  assert.equal(ev.msgIndex, 2);
  assert.equal(ev.amount0, 502233140n);
  assert.equal(ev.amount1, 4211211061n);
  assert.equal(ev.maker, "terra1ydeh9exz82qrzw82ycjr6n462u5ldt8m8qt4rh");
});

test("EXIT ASTRO 0EB64E03 (FCD archive, block 29033354): refund_assets; maker = tx signer", () => {
  const tx = fcdTx("0EB64E03B020316AD0130A1DA5B85B38FF33F25AF44FB7E7A9FB13DC5E5F32A1");
  const ev = only(extractPairEvents(tx, ASTRO));
  assert.equal(ev.eventType, "exit");
  assert.equal(ev.amount0, 700693217n);
  assert.equal(ev.amount1, 5499999999n);
  assert.equal(ev.maker, "terra1uvtvrqvxqwnj344zw4rz3l2h45y53qqemlxhz2");
  const { deltas } = balanceDeltas(tx, ASTRO.id, [ASTRO.asset0Id, CW]);
  assert.deepEqual(
    deltas.map((d) => [d.assetId, d.amount]),
    [
      [ASTRO.asset0Id, -700693217n],
      [CW, -5499999999n],
    ],
  );
});

test("parseAssetList: TerraSwap string and JSON array forms", () => {
  const s = parseAssetList("123uluna, 456terra1xj49zyqrwpv5k928jwfpfy2ha668nwdgkwlrg3")!;
  assert.equal(s.get("uluna"), 123n);
  assert.equal(s.get("terra1xj49zyqrwpv5k928jwfpfy2ha668nwdgkwlrg3"), 456n);
  const j = parseAssetList(
    JSON.stringify([
      { info: { native_token: { denom: "uluna" } }, amount: "7" },
      { info: { token: { contract_addr: CW } }, amount: "8" },
    ]),
  )!;
  assert.equal(j.get("uluna"), 7n);
  assert.equal(j.get(CW), 8n);
  assert.equal(parseAssetList("12 garbage"), null);
});

test("failed txs (code != 0) produce no events", () => {
  const tx = { ...lcdTx("72983185E1B2C06330A238D723B802A40C647FBFB6D092B604F479A197109C6D"), code: 5 };
  assert.equal(extractPairEvents(tx, WESO).length, 0);
});

test("zero-amount swap is omitted instead of emitting priceNative 0 or a fake price", () => {
  const tx = lcdTx("746A91D1EC0FB16BD06528389D32E7CBBBC402513D62FBB8FB97BAF48C840556");
  const mutated = JSON.parse(JSON.stringify(tx));
  for (const e of mutated.events) for (const a of e.attributes) if (a.key === "offer_amount") a.value = "0";
  assert.equal(extractPairEvents(mutated, WESO).length, 0);
});

test("swap with unknown asset ids is a hard error, not silently dropped", () => {
  const tx = lcdTx("746A91D1EC0FB16BD06528389D32E7CBBBC402513D62FBB8FB97BAF48C840556");
  const mutated = JSON.parse(JSON.stringify(tx));
  for (const e of mutated.events) for (const a of e.attributes) if (a.key === "ask_asset") a.value = "uusd";
  assert.throws(() => extractPairEvents(mutated, WESO), /unexpected assets/);
});
