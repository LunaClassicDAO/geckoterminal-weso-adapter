import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import type { Transport, TransportResponse } from "../src/upstream.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixtureJson<T = any>(rel: string): T {
  const p = path.join(FIXTURES, rel);
  const buf = fs.readFileSync(p);
  return JSON.parse((p.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8")) as T;
}

export type Recording = Record<string, TransportResponse>;

export function keyOf(pathAndQuery: string, headers: Record<string, string>): string {
  const h = headers["x-cosmos-block-height"];
  return h != null ? `${pathAndQuery}|height=${h}` : pathAndQuery;
}

/** Serves recorded upstream responses; unknown requests fail the test loudly. */
export function replayTransport(rec: Recording, opts: { onRequest?: (key: string) => void } = {}): Transport {
  return async (_base, pathAndQuery, headers) => {
    const key = keyOf(pathAndQuery, headers);
    opts.onRequest?.(key);
    const hit = rec[key];
    if (!hit) throw new Error(`no recorded upstream response for ${key}`);
    return hit;
  };
}

export function recordingTransport(inner: Transport, rec: Recording): Transport {
  return async (base, pathAndQuery, headers, timeoutMs) => {
    const res = await inner(base, pathAndQuery, headers, timeoutMs);
    if (res.status === 200 || res.status === 400) rec[keyOf(pathAndQuery, headers)] = res;
    return res;
  };
}

export function loadRecording(name: string): Recording {
  return fixtureJson<Recording>(path.join("upstream", `${name}.json.gz`));
}

export function saveRecording(name: string, rec: Recording): void {
  const dir = path.join(FIXTURES, "upstream");
  fs.mkdirSync(dir, { recursive: true });
  const sorted: Recording = {};
  for (const k of Object.keys(rec).sort()) sorted[k] = rec[k];
  fs.writeFileSync(path.join(dir, `${name}.json.gz`), zlib.gzipSync(JSON.stringify(sorted), { level: 9 }));
}

/** LCD GetTx fixture -> TxResponse (with tx body attached, as tx search returns it). */
export function lcdTx(hash: string): import("../src/upstream.js").TxResponse {
  const d = fixtureJson<any>(path.join("lcd", `${hash}.json`));
  return { ...d.tx_response, tx: d.tx };
}

/**
 * FCD archive tx (amino JSON) -> LCD-shaped TxResponse. Only used for txs older
 * than the LCD's retained history (join/exit + reBASE fixtures). Messages are
 * mapped 1:1 ("wasm/MsgExecuteContract" -> "/cosmwasm.wasm.v1.MsgExecuteContract");
 * per-message `logs` are kept verbatim.
 */
export function fcdTx(hash: string): import("../src/upstream.js").TxResponse {
  const t = fixtureJson<any>(path.join("fcd", `${hash}.json`));
  const typeMap: Record<string, string> = { "wasm/MsgExecuteContract": "/cosmwasm.wasm.v1.MsgExecuteContract" };
  const msgs = (t.tx?.value?.msg ?? []).map((m: any) => {
    const ty = typeMap[m.type];
    if (!ty) throw new Error(`unmapped amino msg type ${m.type}`);
    return { "@type": ty, ...m.value };
  });
  return {
    height: String(t.height),
    txhash: t.txhash,
    code: t.code ?? 0,
    timestamp: t.timestamp,
    tx: { body: { messages: msgs } },
    logs: t.logs,
  };
}
