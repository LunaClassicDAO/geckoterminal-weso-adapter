import assert from "node:assert/strict";
import { test } from "node:test";
import { decimalize, ratio, rateToBps } from "../src/decimal.js";

test("decimalize is exact and trims zeros", () => {
  assert.equal(decimalize("11895131788", 6), "11895.131788");
  assert.equal(decimalize("1000000", 6), "1");
  assert.equal(decimalize("0", 6), "0");
  assert.equal(decimalize("5", 8), "0.00000005");
  assert.equal(decimalize(-1500000n, 6), "-1.5");
  assert.equal(decimalize("123456789012345678901234567890", 18), "123456789012.34567890123456789");
  assert.throws(() => decimalize("1.5", 6));
  assert.throws(() => decimalize("-1", 6));
});

test("ratio truncates to 50 places without floats", () => {
  assert.equal(ratio(1n, 0, 3n, 0), "0." + "3".repeat(50));
  assert.equal(ratio(2n, 0, 3n, 0), "0." + "6".repeat(50)); // truncated, not rounded
  assert.equal(ratio(298663437n, 6, 11777369984n, 6), "0.02535909438234049793098526809429985552876386565593");
  assert.equal(ratio(1n, 6, 0n, 6), null);
  // mixed decimals (WAVAX 8 / cwLUNC 6): 1 WAVAX for 2.5 cwLUNC
  assert.equal(ratio(2500000n, 6, 100000000n, 8), "2.5");
  // 1e-60 truncates to 0 at 50 places
  assert.equal(ratio(1n, 30, 1n, 0), "0.000000000000000000000000000001");
  assert.equal(ratio(1n, 60, 1n, 0), "0");
});

test("rateToBps is exact", () => {
  assert.equal(rateToBps("0.002"), 20);
  assert.equal(rateToBps("0.01"), 100);
  assert.equal(rateToBps("0"), 0);
  assert.throws(() => rateToBps("0.00015")); // 1.5 bps is not an integer
  assert.throws(() => rateToBps("abc"));
});
