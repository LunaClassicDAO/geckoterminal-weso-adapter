import { HTTP_TIMEOUT_MS, LCD_URL, FCD_URL } from "./config.js";

const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; WESO-GeckoTerminal-Adapter/1.0)",
  Accept: "application/json",
};

export class LcdError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "LcdError";
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...HEADERS, ...(init?.headers as Record<string, string>) },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LcdError(
        `HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function querySmart<T>(
  contract: string,
  query: object,
  height?: number,
): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  let url = `${LCD_URL}/cosmwasm/wasm/v1/contract/${contract}/smart/${encoded}`;
  const headers: Record<string, string> = { ...HEADERS };
  if (height != null && Number.isFinite(height)) {
    url += `?height=${height}`;
    headers["x-cosmos-block-height"] = String(height);
  }
  const res = await fetchJson<{ data: T }>(url, { headers });
  if (res == null || res.data === undefined) {
    throw new LcdError(`Smart query returned no data for ${contract}`);
  }
  return res.data;
}

export interface LatestBlockInfo {
  blockNumber: number;
  blockTimestamp: number;
}

export async function getLatestBlock(): Promise<LatestBlockInfo> {
  const res = await fetchJson<{
    block: { header: { height: string; time: string } };
  }>(`${LCD_URL}/cosmos/base/tendermint/v1beta1/blocks/latest`);
  const height = Number(res.block.header.height);
  const ts = Math.floor(Date.parse(res.block.header.time) / 1000);
  if (!Number.isFinite(height) || !Number.isFinite(ts)) {
    throw new LcdError("Invalid latest block payload");
  }
  return { blockNumber: height, blockTimestamp: ts };
}

export async function getBlockTimestamp(height: number): Promise<number> {
  const res = await fetchJson<{
    block: { header: { time: string } };
  }>(`${LCD_URL}/cosmos/base/tendermint/v1beta1/blocks/${height}`);
  const ts = Math.floor(Date.parse(res.block.header.time) / 1000);
  if (!Number.isFinite(ts)) throw new LcdError(`Bad time for height ${height}`);
  return ts;
}

export interface TxResponse {
  height: string;
  txhash: string;
  timestamp?: string;
  code?: number;
  tx?: {
    body?: {
      messages?: Array<Record<string, unknown>>;
    };
  };
  logs?: Array<{
    msg_index?: number;
    events?: Array<{
      type: string;
      attributes: Array<{ key: string; value: string }>;
    }>;
  }>;
  events?: Array<{
    type: string;
    attributes: Array<{ key: string; value: string }>;
  }>;
}

/** Height-scoped wasm contract search (preferred for /events). */
export async function searchTxsByContractAndHeight(
  contract: string,
  fromBlock: number,
  toBlock: number,
  limit = 100,
): Promise<TxResponse[]> {
  const q = `tx.height>=${fromBlock} AND tx.height<=${toBlock} AND wasm._contract_address='${contract}'`;
  const url =
    `${LCD_URL}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(q)}` +
    `&pagination.limit=${limit}&order_by=2`;
  const res = await fetchJson<{
    tx_responses?: TxResponse[];
    message?: string;
  }>(url);
  return res.tx_responses || [];
}

/** FCD account txs — useful fallback / discovery. */
export async function fcdAccountTxs(
  account: string,
  limit: 10 | 100 = 100,
  offset?: number,
): Promise<{ txs: any[]; next?: number }> {
  const qs = new URLSearchParams({
    account,
    limit: String(limit),
  });
  if (offset != null) qs.set("offset", String(offset));
  return fetchJson(`${FCD_URL}/v1/txs?${qs.toString()}`);
}

export { LCD_URL, FCD_URL };
