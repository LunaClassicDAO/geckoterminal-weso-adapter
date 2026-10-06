import {
  HTTP_TIMEOUT_MS,
  LCD_URLS,
  TX_SEARCH_PAGE_SIZE,
  UPSTREAM_ATTEMPTS,
  UPSTREAM_BACKOFF_MS,
  UPSTREAM_BACKOFF_MAX_MS,
} from "./config.js";

/**
 * Error surfaced to HTTP clients. `message` is always safe to show: it never
 * contains upstream URLs or raw upstream bodies.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** Last upstream response body (server-side diagnostics only; never sent to clients). */
  upstreamBody?: string;
}

/** Upstream answered with a non-retriable 4xx on every upstream. */
export class UpstreamClientError extends Error {
  constructor(
    public httpStatus: number,
    public body: string,
  ) {
    super(`upstream returned HTTP ${httpStatus}`);
    this.name = "UpstreamClientError";
  }
}

export interface TransportResponse {
  status: number;
  text: string;
}

/** Pluggable HTTP transport so tests can replay recorded upstream responses. */
export type Transport = (
  base: string,
  pathAndQuery: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<TransportResponse>;

const HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; WESO-GeckoTerminal-Adapter/2.0)",
  Accept: "application/json",
};

export const fetchTransport: Transport = async (base, pathAndQuery, headers, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + pathAndQuery, { headers, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
};

let transport: Transport = fetchTransport;
let upstreamUrls: string[] = LCD_URLS;
let backoffMs = UPSTREAM_BACKOFF_MS;
let attemptsPerUpstream = UPSTREAM_ATTEMPTS;

export function getUpstreamUrls(): string[] {
  return upstreamUrls;
}

/** Test hook: swap transport / upstream list / retry policy. */
export function configureUpstream(opts: {
  transport?: Transport;
  urls?: string[];
  backoffMs?: number;
  attempts?: number;
}): void {
  if (opts.transport) transport = opts.transport;
  if (opts.urls) upstreamUrls = opts.urls;
  if (opts.backoffMs != null) backoffMs = opts.backoffMs;
  if (opts.attempts != null) attemptsPerUpstream = opts.attempts;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetriableStatus(s: number): boolean {
  return s === 429 || s >= 500;
}

/**
 * One logical client request (e.g. one /events call). Calls are pinned to a
 * single upstream; if it keeps failing after retries the session fails over to
 * the next configured upstream and stays there for the rest of the request.
 */
export class Session {
  private idx = 0;
  constructor(private readonly urls: string[] = upstreamUrls) {
    if (!urls.length) throw new Error("no upstreams configured");
  }

  get upstreamIndex(): number {
    return this.idx;
  }

  async getJson<T>(pathAndQuery: string, height?: number): Promise<T> {
    let lastErr: unknown = null;
    let lastBody: string | undefined;
    let lastClient: UpstreamClientError | null = null;
    for (let u = this.idx; u < this.urls.length; u++) {
      const headers: Record<string, string> = { ...HEADERS };
      if (height != null) headers["x-cosmos-block-height"] = String(height);
      for (let attempt = 1; attempt <= attemptsPerUpstream; attempt++) {
        try {
          const res = await transport(this.urls[u], pathAndQuery, headers, HTTP_TIMEOUT_MS);
          if (res.status === 200) {
            let parsed: T;
            try {
              parsed = JSON.parse(res.text) as T;
            } catch {
              throw new Error("upstream returned invalid JSON");
            }
            this.idx = u; // pin
            return parsed;
          }
          if (!isRetriableStatus(res.status)) {
            lastClient = new UpstreamClientError(res.status, res.text.slice(0, 500));
            break; // no point retrying this upstream; try next one
          }
          lastBody = res.text.slice(0, 500);
          lastErr = new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
        } catch (e) {
          lastErr = e;
        }
        if (attempt < attemptsPerUpstream) await sleep(Math.min(backoffMs * 2 ** (attempt - 1), UPSTREAM_BACKOFF_MAX_MS));
      }
      console.warn(
        `[upstream] #${u} failed for ${pathAndQuery.split("?")[0]}${height != null ? `@${height}` : ""}: ${
          lastClient ? `HTTP ${lastClient.httpStatus}` : String((lastErr as Error)?.message ?? lastErr)
        }`,
      );
    }
    // Only a definitive 4xx from every upstream is surfaced as a client error;
    // anything involving timeouts / 5xx is "unavailable" so the caller returns 5xx.
    if (lastClient && lastErr == null) throw lastClient;
    const err = new ApiError(502, "upstream_unavailable", "Upstream node request failed after retries");
    err.upstreamBody = lastBody ?? lastClient?.body;
    throw err;
  }

  // ---------------------------------------------------------------- queries

  async smart<T>(contract: string, query: object, height?: number): Promise<T> {
    const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
    const path =
      `/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(encoded)}` +
      (height != null ? `?height=${height}` : "");
    const res = await this.getJson<{ data?: T }>(path, height);
    if (res == null || res.data === undefined || res.data === null) {
      throw new ApiError(502, "upstream_bad_response", "Upstream returned an empty contract query result");
    }
    return res.data;
  }

  async cw20Balance(token: string, address: string, height: number): Promise<bigint> {
    const r = await this.smart<{ balance?: string }>(token, { balance: { address } }, height);
    if (typeof r.balance !== "string" || !/^\d+$/.test(r.balance)) {
      throw new ApiError(502, "upstream_bad_response", "Upstream returned a malformed CW20 balance");
    }
    return BigInt(r.balance);
  }

  async bankBalance(address: string, denom: string, height: number): Promise<bigint> {
    const r = await this.getJson<{ balance?: { denom?: string; amount?: string } }>(
      `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}&height=${height}`,
      height,
    );
    const amt = r.balance?.amount;
    if (r.balance?.denom !== denom || typeof amt !== "string" || !/^\d+$/.test(amt)) {
      throw new ApiError(502, "upstream_bad_response", "Upstream returned a malformed bank balance");
    }
    return BigInt(amt);
  }

  async latestHeight(): Promise<number> {
    const r = await this.getJson<BlockResponse>(`/cosmos/base/tendermint/v1beta1/blocks/latest`);
    return parseHeight(r);
  }

  /**
   * Fetch block `height`. Throws ApiError(503, "height_not_available") when the
   * node has pruned it (with lowestAvailableBlock if the node reports it).
   */
  async block(height: number): Promise<BlockResponse> {
    try {
      const r = await this.getJson<BlockResponse>(`/cosmos/base/tendermint/v1beta1/blocks/${height}`);
      if (parseHeight(r) !== height) {
        throw new ApiError(502, "upstream_bad_response", "Upstream returned a different block than requested");
      }
      return r;
    } catch (e) {
      // Pruned heights come back as HTTP 500 {"code":2,"message":"height X is not
      // available, lowest height is Y"} (after retries) or as a 4xx on some nodes.
      const body = e instanceof UpstreamClientError ? e.body : e instanceof ApiError ? e.upstreamBody : undefined;
      const lowestAny = body != null ? parseLowestHeight(body) : null;
      if (lowestAny != null) {
        throw new ApiError(
          503,
          "height_not_available",
          `Block ${height} is below the oldest block retained by the upstream node`,
          { lowestAvailableBlock: lowestAny },
        );
      }
      if (e instanceof UpstreamClientError) {
        const lowest = parseLowestHeight(e.body);
        if (lowest != null) {
          throw new ApiError(
            503,
            "height_not_available",
            `Block ${height} is below the oldest block retained by the upstream node`,
            { lowestAvailableBlock: lowest },
          );
        }
        if (/bigger then the chain length|must be less than or equal to the current blockchain height/i.test(e.body)) {
          // callers only ask for heights at or below a verified tip, so this is a lagging backend
          throw new ApiError(503, "upstream_behind", `Upstream node has not reached block ${height} yet`);
        }
        throw new ApiError(502, "upstream_bad_response", `Upstream rejected block ${height} request`);
      }
      throw e;
    }
  }

  /**
   * Run a tx search, walking EVERY page in ascending height order. Verifies the
   * collected count equals the reported total and that hashes are unique.
   */
  async searchTxsAll(query: string): Promise<TxResponse[]> {
    const out: TxResponse[] = [];
    const seen = new Set<string>();
    let total: number | null = null;
    for (let page = 1; ; page++) {
      const qs =
        `query=${encodeURIComponent(query)}` +
        `&order_by=ORDER_BY_ASC&page=${page}&limit=${TX_SEARCH_PAGE_SIZE}`;
      let res: TxSearchResponse;
      try {
        res = await this.getJson<TxSearchResponse>(`/cosmos/tx/v1beta1/txs?${qs}`);
      } catch (e) {
        if (e instanceof UpstreamClientError) {
          throw new ApiError(502, "upstream_bad_response", "Upstream rejected tx search request");
        }
        throw e;
      }
      const t = Number(res.total ?? res.pagination?.total);
      if (!Number.isInteger(t) || t < 0) {
        throw new ApiError(502, "upstream_bad_response", "Upstream tx search returned no total");
      }
      if (total == null) total = t;
      else if (t !== total) {
        throw new ApiError(503, "upstream_inconsistent", "Upstream tx search total changed between pages");
      }
      const txs = res.tx_responses || [];
      for (const tx of txs) {
        if (seen.has(tx.txhash)) {
          throw new ApiError(503, "upstream_inconsistent", "Upstream tx search returned a duplicate tx");
        }
        seen.add(tx.txhash);
        out.push(tx);
      }
      if (out.length >= total) break;
      if (!txs.length) {
        throw new ApiError(503, "upstream_inconsistent", "Upstream tx search ended before reported total");
      }
    }
    if (out.length !== total) {
      throw new ApiError(503, "upstream_inconsistent", "Upstream tx search returned more txs than reported");
    }
    for (let i = 1; i < out.length; i++) {
      if (Number(out[i].height) < Number(out[i - 1].height)) {
        throw new ApiError(503, "upstream_inconsistent", "Upstream tx search results not in ascending order");
      }
    }
    return out;
  }
}

export interface BlockResponse {
  block_id?: { hash?: string };
  block?: {
    header?: { height?: string; time?: string };
    data?: { txs?: string[] | null };
  };
}

export interface TxSearchResponse {
  tx_responses?: TxResponse[];
  total?: string;
  pagination?: { total?: string };
}

export interface RawEvent {
  type: string;
  attributes: Array<{ key: string; value: string; index?: boolean }>;
}

export interface TxResponse {
  height: string;
  txhash: string;
  code?: number;
  timestamp?: string;
  tx?: {
    body?: { messages?: Array<Record<string, unknown>> };
  };
  logs?: Array<{ msg_index?: number; events?: RawEvent[] }>;
  events?: RawEvent[];
}

function parseHeight(r: BlockResponse): number {
  const h = r?.block?.header?.height;
  if (typeof h !== "string" || !/^\d+$/.test(h)) {
    throw new ApiError(502, "upstream_bad_response", "Upstream returned a malformed block");
  }
  return Number(h);
}

export function parseLowestHeight(body: string): number | null {
  const m = /lowest height is (\d+)/i.exec(body);
  return m ? Number(m[1]) : null;
}

export function blockTimestamp(r: BlockResponse): number {
  const t = r?.block?.header?.time;
  const ms = typeof t === "string" ? Date.parse(t) : NaN;
  if (!Number.isFinite(ms)) {
    throw new ApiError(502, "upstream_bad_response", "Upstream returned a block without a valid time");
  }
  return Math.floor(ms / 1000);
}
