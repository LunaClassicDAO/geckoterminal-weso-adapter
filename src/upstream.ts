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
  /** Lowest retained height reported by any upstream during the failed call (server-side hint). */
  lowestAvailableBlock?: number | null;
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
  /**
   * Value of the `x-cosmos-block-height` response header, when the node sends
   * it (hexxagon / stakely do, publicnode does not). Used to reject at-height
   * answers served from a different height.
   */
  height?: string | null;
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
    return { status: res.status, text, height: res.headers.get("x-cosmos-block-height") };
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sleep for the configured exponential backoff of retry `attempt` (1-based). */
export function backoff(attempt: number): Promise<void> {
  return sleep(Math.min(backoffMs * 2 ** (attempt - 1), UPSTREAM_BACKOFF_MAX_MS));
}

function isRetriableStatus(s: number): boolean {
  return s === 429 || s >= 500;
}

/** Upstream bodies that mean "this node no longer has state / blocks at that height". */
const PRUNED_STATE_RE =
  /version does not exist|failed to load state at height|version mismatch on immutable|is not available, lowest height is/i;
/** Definitive block-store floor: retrying the same node cannot help, move to the next one at once. */
const BLOCK_FLOOR_RE = /is not available, lowest height is/i;
/**
 * Pruned-state answers are retried a few times on the same node only (load-balanced
 * backends differ in pruning, so a retry may land on one that has the height),
 * then the next node is asked.
 */
const PRUNED_STATE_ATTEMPTS = 3;

export interface GetJsonOptions<T> {
  /** At-height state read: sends x-cosmos-block-height and verifies the echoed height. */
  height?: number;
  /** Returns an error message when a 200 answer is empty / malformed (retried, then failed over). */
  validate?: (parsed: T) => string | null;
}

/**
 * One logical client request (e.g. one /events call).
 *
 * - Non-height reads (tx search, blocks, tip) are pinned to one upstream. When
 *   it keeps failing (errors, empty or malformed answers) the session fails
 *   over to the next upstream, wrapping around the configured list, and stays
 *   there. If the session has a required tip (see `requireTip`), an upstream is
 *   only used once its own tip is verified to cover it, so a lagging node can
 *   never silently shorten a tx search.
 * - At-height state reads are self-verifying (echoed height + the per-block
 *   reserve invariant), so they may be served by any upstream: they start at a
 *   rotating index (`rotateHeightReads`) and move to the next node on errors,
 *   empty answers, or an echoed `x-cosmos-block-height` that differs from the
 *   requested height. They never move the pin.
 */
export class Session {
  private idx: number;
  private heightIdx: number;
  private requiredTip: number | null = null;
  private readonly tipOk = new Map<number, boolean>();

  constructor(
    private readonly urls: string[] = upstreamUrls,
    start = 0,
  ) {
    if (!urls.length) throw new Error("no upstreams configured");
    if (!Number.isInteger(start) || start < 0 || start >= urls.length) throw new Error("bad upstream start index");
    this.idx = start;
    this.heightIdx = start;
  }

  get upstreamIndex(): number {
    return this.idx;
  }

  /**
   * Non-height reads may only fail over to upstreams whose tip is >= `tip`.
   * `verifiedIdx` marks an upstream whose tip was already checked.
   */
  requireTip(tip: number, verifiedIdx?: number): void {
    this.requiredTip = tip;
    this.tipOk.clear();
    if (verifiedIdx != null) this.tipOk.set(verifiedIdx, true);
  }

  /** Start the next at-height reads on the following upstream (used after a stale / inconsistent read). */
  rotateHeightReads(): void {
    this.heightIdx = (this.heightIdx + 1) % this.urls.length;
  }

  private async upstreamCoversTip(u: number): Promise<boolean> {
    if (this.requiredTip == null) return true;
    const known = this.tipOk.get(u);
    if (known != null) return known;
    let ok = false;
    try {
      ok = (await new Session([this.urls[u]]).latestHeight()) >= this.requiredTip;
    } catch {
      ok = false;
    }
    this.tipOk.set(u, ok);
    if (!ok) console.warn(`[upstream] #${u} skipped: tip below required ${this.requiredTip}`);
    return ok;
  }

  async getJson<T>(pathAndQuery: string, opts: GetJsonOptions<T> | number = {}): Promise<T> {
    const o: GetJsonOptions<T> = typeof opts === "number" ? { height: opts } : opts;
    const height = o.height;
    const n = this.urls.length;
    const start = height != null ? this.heightIdx : this.idx;
    let lastErr: unknown = null;
    let lastBody: string | undefined;
    let lastClient: UpstreamClientError | null = null;
    let lastInvalid: string | null = null;
    let mismatches = 0;
    let lowest: number | null = null;
    const noteBody = (b: string) => {
      lastBody = b;
      const l = parseLowestHeight(b);
      if (l != null) lowest = lowest == null ? l : Math.min(lowest, l);
    };
    for (let k = 0; k < n; k++) {
      const u = (start + k) % n;
      if (height == null && u !== this.idx && !(await this.upstreamCoversTip(u))) continue;
      const headers: Record<string, string> = { ...HEADERS };
      if (height != null) headers["x-cosmos-block-height"] = String(height);
      for (let attempt = 1; attempt <= attemptsPerUpstream; attempt++) {
        let moveOn = false;
        try {
          const res = await transport(this.urls[u], pathAndQuery, headers, HTTP_TIMEOUT_MS);
          if (res.status === 200) {
            if (height != null && res.height != null && res.height !== "" && res.height !== String(height)) {
              // node served another height (stuck / lagging / ignoring the header): never accept, try another node
              mismatches++;
              lastErr = new Error(`height mismatch: asked ${height}, got ${res.height}`);
              moveOn = true;
            } else {
              let parsed: T;
              try {
                parsed = JSON.parse(res.text) as T;
              } catch {
                throw new Error("upstream returned invalid JSON");
              }
              const invalid = o.validate ? o.validate(parsed) : null;
              if (invalid == null) {
                if (height == null) this.idx = u; // pin (non-height reads only)
                return parsed;
              }
              lastInvalid = invalid;
              lastErr = new Error(invalid);
            }
          } else if (!isRetriableStatus(res.status)) {
            lastClient = new UpstreamClientError(res.status, res.text.slice(0, 500));
            noteBody(res.text.slice(0, 500));
            moveOn = true; // no point retrying this upstream; try next one
          } else {
            noteBody(res.text.slice(0, 500));
            lastErr = new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
            if (BLOCK_FLOOR_RE.test(res.text)) moveOn = true;
            else if (attempt >= PRUNED_STATE_ATTEMPTS && PRUNED_STATE_RE.test(res.text)) moveOn = true;
          }
        } catch (e) {
          lastErr = e;
        }
        if (moveOn) break;
        if (attempt < attemptsPerUpstream) await backoff(attempt);
      }
      console.warn(
        `[upstream] #${u} failed for ${pathAndQuery.split("?")[0]}${height != null ? `@${height}` : ""}: ${
          lastClient && lastErr == null ? `HTTP ${lastClient.httpStatus}` : String((lastErr as Error)?.message ?? lastErr)
        }`,
      );
    }
    // Only a definitive 4xx from every upstream is surfaced as a client error;
    // anything involving timeouts / 5xx is "unavailable" so the caller returns 5xx.
    if (lastClient && lastErr == null) throw lastClient;
    let err: ApiError;
    if (height != null && lastBody != null && PRUNED_STATE_RE.test(lastBody) && mismatches === 0 && lastInvalid == null) {
      err = new ApiError(503, "height_not_available", `State at block ${height} is not retained by any upstream node`);
    } else if (mismatches > 0 && lastInvalid == null && lastBody == null) {
      err = new ApiError(503, "upstream_inconsistent", `Upstream nodes answered block ${height} queries from another height`);
    } else if (lastInvalid != null) {
      err = new ApiError(502, "upstream_bad_response", lastInvalid);
    } else {
      err = new ApiError(502, "upstream_unavailable", "Upstream node request failed after retries");
    }
    err.upstreamBody = lastBody ?? lastClient?.body;
    err.lowestAvailableBlock = lowest;
    throw err;
  }

  // ---------------------------------------------------------------- queries

  async smart<T>(contract: string, query: object, height?: number, check?: (d: T) => string | null): Promise<T> {
    const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
    const path =
      `/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(encoded)}` +
      (height != null ? `?height=${height}` : "");
    const res = await this.getJson<{ data?: T }>(path, {
      height,
      validate: (r) => {
        if (r == null || r.data === undefined || r.data === null) return "Upstream returned an empty contract query result";
        return check ? check(r.data) : null;
      },
    });
    return res.data as T;
  }

  async cw20Balance(token: string, address: string, height: number): Promise<bigint> {
    const r = await this.smart<{ balance?: string }>(token, { balance: { address } }, height, (d) =>
      typeof d.balance === "string" && /^\d+$/.test(d.balance) ? null : "Upstream returned a malformed CW20 balance",
    );
    return BigInt(r.balance as string);
  }

  async bankBalance(address: string, denom: string, height: number): Promise<bigint> {
    const r = await this.getJson<{ balance?: { denom?: string; amount?: string } }>(
      `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}&height=${height}`,
      {
        height,
        validate: (b) =>
          b?.balance?.denom === denom && typeof b.balance.amount === "string" && /^\d+$/.test(b.balance.amount)
            ? null
            : "Upstream returned a malformed bank balance",
      },
    );
    return BigInt(r.balance!.amount!);
  }

  async latestHeight(): Promise<number> {
    const r = await this.getJson<BlockResponse>(`/cosmos/base/tendermint/v1beta1/blocks/latest`, {
      validate: (b) => (heightOf(b) == null ? "Upstream returned a malformed block" : null),
    });
    return parseHeight(r);
  }

  /**
   * Fetch block `height`. Throws ApiError(503, "height_not_available") when no
   * upstream retains it (with lowestAvailableBlock = the lowest height any
   * upstream reported). A node answering with a different block is failed over.
   */
  async block(height: number): Promise<BlockResponse> {
    try {
      return await this.getJson<BlockResponse>(`/cosmos/base/tendermint/v1beta1/blocks/${height}`, {
        validate: (b) => {
          const h = heightOf(b);
          if (h == null) return "Upstream returned a malformed block";
          return h !== height ? "Upstream returned a different block than requested" : null;
        },
      });
    } catch (e) {
      // Pruned heights come back as HTTP 500 {"code":2,"message":"height X is not
      // available, lowest height is Y"} (after retries) or as a 4xx on some nodes.
      const lowestAny =
        e instanceof ApiError
          ? e.lowestAvailableBlock ?? (e.upstreamBody != null ? parseLowestHeight(e.upstreamBody) : null)
          : e instanceof UpstreamClientError
            ? parseLowestHeight(e.body)
            : null;
      if (lowestAny != null && lowestAny > height) {
        throw new ApiError(
          503,
          "height_not_available",
          `Block ${height} is below the oldest block retained by the upstream node`,
          { lowestAvailableBlock: lowestAny },
        );
      }
      if (e instanceof UpstreamClientError) {
        if (/bigger then the chain length|must be less than or equal to the current blockchain height/i.test(e.body)) {
          // callers only ask for heights at or below a verified tip, so this is a lagging backend
          throw new ApiError(503, "upstream_behind", `Upstream node has not reached block ${height} yet`);
        }
        throw new ApiError(502, "upstream_bad_response", `Upstream rejected block ${height} request`);
      }
      throw e;
    }
  }

  /** Number of txs matching `query` according to the tx index (one cheap page). */
  async txCount(query: string): Promise<number> {
    let res: TxSearchResponse;
    try {
      res = await this.getJson<TxSearchResponse>(
        `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(query)}&order_by=ORDER_BY_ASC&page=1&limit=1`,
        { validate: (r) => (totalOf(r) == null ? "Upstream tx search returned no total" : null) },
      );
    } catch (e) {
      if (e instanceof UpstreamClientError) {
        throw new ApiError(502, "upstream_bad_response", "Upstream rejected tx search request");
      }
      throw e;
    }
    return totalOf(res)!;
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
        res = await this.getJson<TxSearchResponse>(`/cosmos/tx/v1beta1/txs?${qs}`, {
          validate: (r) => (totalOf(r) == null ? "Upstream tx search returned no total" : null),
        });
      } catch (e) {
        if (e instanceof UpstreamClientError) {
          throw new ApiError(502, "upstream_bad_response", "Upstream rejected tx search request");
        }
        throw e;
      }
      const t = totalOf(res)!;
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

function totalOf(r: TxSearchResponse): number | null {
  const t = Number(r?.total ?? r?.pagination?.total);
  return Number.isInteger(t) && t >= 0 ? t : null;
}

function heightOf(r: BlockResponse): number | null {
  const h = r?.block?.header?.height;
  return typeof h === "string" && /^\d+$/.test(h) ? Number(h) : null;
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
