/**
 * Tiny synthetic Terra Classic LCD for end-to-end tests of paths that never
 * occurred in retained mainnet history (several events of one pair in one tx,
 * upstream fail-over). Serves blocks, tx search, CW20 / bank balances at height
 * from an in-memory chain description, in the exact response shapes of the LCD.
 */
import { createHash } from "node:crypto";
import type { ResolvedPair } from "../src/pairs.js";
import type { RawEvent, Transport, TransportResponse, TxResponse } from "../src/upstream.js";

export const USER = "terra1user0000000000000000000000000000000000";
export const VAULT = "terra1vault000000000000000000000000000000000";
export const PAIR = "terra1pair0000000000000000000000000000000000";
export const TOKA = "terra1tokena00000000000000000000000000000000";
export const TOKB = "terra1tokenb00000000000000000000000000000000";
export const CURVE = "terra1curve000000000000000000000000000000000";

export const AMM_PAIR: ResolvedPair = {
  pair: { id: PAIR, dexKey: "weso-defi", asset0Id: TOKA, asset1Id: TOKB, name: "TOKA/TOKB", feeBps: 20 },
  def: { id: PAIR, asset0Id: TOKA, asset1Id: TOKB, asset0Decimals: 6, asset1Decimals: 6, kind: "amm" },
};
export const CURVE_PAIR: ResolvedPair = {
  pair: { id: CURVE, dexKey: "weso-defi", asset0Id: "uluna", asset1Id: CURVE, name: "LUNC/CRV", feeBps: 100 },
  def: { id: CURVE, asset0Id: "uluna", asset1Id: CURVE, asset0Decimals: 6, asset1Decimals: 6, kind: "curve" },
};

export interface ChainTx {
  /** raw tx bytes (any string); the hash is sha256 of them, as on chain */
  bytes: string;
  messages: number; // number of MsgExecuteContract signed by USER
  events: RawEvent[];
}

export interface Chain {
  tip: number;
  /** height -> txs in block order */
  blocks: Map<number, ChainTx[]>;
  /** balance(holder, assetId) AFTER block h (assets: cw20 address or native denom) */
  balanceAt: (holder: string, assetId: string, h: number) => bigint;
}

export const b64 = (s: string) => Buffer.from(s).toString("base64");
export const hashOf = (bytes: string) => createHash("sha256").update(Buffer.from(bytes)).digest("hex").toUpperCase();

export function txResponse(h: number, t: ChainTx): TxResponse {
  return {
    height: String(h),
    txhash: hashOf(t.bytes),
    code: 0,
    tx: {
      body: {
        messages: Array.from({ length: t.messages }, () => ({
          "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
          sender: USER,
        })),
      },
    },
    events: t.events,
  };
}

const ok = (o: unknown, height?: number): TransportResponse => ({
  status: 200,
  text: JSON.stringify(o),
  ...(height != null ? { height: String(height) } : {}),
});

/** Transport answering like a healthy LCD for `chain`. `echoHeight` mimics nodes that echo x-cosmos-block-height. */
export function chainTransport(chain: Chain, opts: { echoHeight?: boolean } = {}): Transport {
  return async (_base, pq, headers): Promise<TransportResponse> => {
    const u = new URL("http://x" + pq);
    const hh = headers["x-cosmos-block-height"];
    const atH = hh != null ? Number(hh) : undefined;
    const echo = opts.echoHeight && atH != null ? atH : undefined;
    if (u.pathname === "/cosmos/base/tendermint/v1beta1/blocks/latest") return ok(blockJson(chain, chain.tip));
    let m = /^\/cosmos\/base\/tendermint\/v1beta1\/blocks\/(\d+)$/.exec(u.pathname);
    if (m) return ok(blockJson(chain, Number(m[1])));
    if (u.pathname === "/cosmos/tx/v1beta1/txs") {
      const q = u.searchParams.get("query")!;
      const page = Number(u.searchParams.get("page"));
      const limit = Number(u.searchParams.get("limit"));
      let all: TxResponse[] = [];
      const eq = /^tx\.height=(\d+)$/.exec(q);
      const rg = /^tx\.height>=(\d+) AND tx\.height<=(\d+) AND wasm\._contract_address='([^']+)'$/.exec(q);
      if (eq) all = (chain.blocks.get(Number(eq[1])) ?? []).map((t) => txResponse(Number(eq[1]), t));
      else if (rg) {
        for (let h = Number(rg[1]); h <= Number(rg[2]); h++) {
          for (const t of chain.blocks.get(h) ?? []) {
            const hit = t.events.some((e) => e.attributes.some((a) => a.key === "_contract_address" && a.value === rg[3]));
            if (hit) all.push(txResponse(h, t));
          }
        }
      } else throw new Error(`unexpected tx query ${q}`);
      return ok({ tx_responses: all.slice((page - 1) * limit, page * limit), total: String(all.length) });
    }
    m = /^\/cosmos\/bank\/v1beta1\/balances\/([^/]+)\/by_denom$/.exec(u.pathname);
    if (m) {
      const denom = u.searchParams.get("denom")!;
      const h = atH ?? chain.tip;
      return ok({ balance: { denom, amount: String(chain.balanceAt(m[1], denom, h)) } }, echo);
    }
    m = /^\/cosmwasm\/wasm\/v1\/contract\/([^/]+)\/smart\/([^/?]+)$/.exec(u.pathname);
    if (m) {
      const q = JSON.parse(Buffer.from(decodeURIComponent(m[2]), "base64").toString("utf8"));
      const h = atH ?? chain.tip;
      if (q.balance) return ok({ data: { balance: String(chain.balanceAt(q.balance.address, m[1], h)) } }, echo);
    }
    throw new Error(`synthetic chain: unexpected request ${pq}`);
  };
}

export function blockJson(chain: Chain, h: number) {
  return {
    block: {
      header: { height: String(h), time: new Date(Date.UTC(2026, 9, 7, 0, 0, 0) + h * 6000).toISOString() },
      data: { txs: (chain.blocks.get(h) ?? []).map((t) => b64(t.bytes)) },
    },
  };
}

// ------------------------------------------------------------ event builders

const ev = (type: string, attrs: Array<[string, string]>, msg?: number): RawEvent => ({
  type,
  attributes: [...attrs, ...(msg != null ? ([["msg_index", String(msg)]] as Array<[string, string]>) : [])].map(
    ([key, value]) => ({ key, value, index: true }),
  ),
});

export const cw20 = (token: string, action: string, from: string, to: string, amount: bigint, msg: number) =>
  ev("wasm", [["_contract_address", token], ["action", action], ["from", from], ["to", to], ["amount", String(amount)]], msg);

export const ammSwap = (offer: string, ask: string, offerAmt: bigint, ret: bigint, commission: bigint, msg: number) =>
  ev(
    "wasm",
    [
      ["_contract_address", PAIR],
      ["action", "swap"],
      ["sender", USER],
      ["receiver", USER],
      ["offer_asset", offer],
      ["ask_asset", ask],
      ["offer_amount", String(offerAmt)],
      ["return_amount", String(ret)],
      ["tax_amount", "0"],
      ["spread_amount", "0"],
      ["commission_amount", String(commission)],
    ],
    msg,
  );

export const execute = (contract: string, msg: number) => ev("execute", [["_contract_address", contract]], msg);

export const coins = (type: "coin_spent" | "coin_received", who: string, amount: string, msg?: number) =>
  ev(type, [[type === "coin_spent" ? "spender" : "receiver", who], ["amount", amount]], msg);

export const curveSwap = (offer: string, ask: string, offerAmt: bigint, ret: bigint, tax: bigint, msg: number) =>
  ev(
    "wasm",
    [
      ["_contract_address", CURVE],
      ["action", "swap"],
      ["offer_asset", offer],
      ["ask_asset", ask],
      ["offer_amount", String(offerAmt)],
      ["return_amount", String(ret)],
      ["tax_amount", String(tax)],
    ],
    msg,
  );

export const feeEvents = (): RawEvent[] => [
  coins("coin_spent", USER, "1000uluna"),
  coins("coin_received", "terra17xpfvakm2amg962yls6f84z3kell8c5lkaeqfa", "1000uluna"),
];
