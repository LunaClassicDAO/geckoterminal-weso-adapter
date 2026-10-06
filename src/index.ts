import cors from "cors";
import express, { type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { BONDING_CURVES, DEX_KEY, FACTORY, MAX_EVENTS_BLOCK_SPAN, PORT, ROUTER } from "./config.js";
import { getAsset } from "./assets.js";
import { getPair, listPairs } from "./pairs.js";
import { getEvents, getLatestBlock, parseRange } from "./events.js";
import { ApiError } from "./upstream.js";

const app = express();
app.disable("x-powered-by");
app.use(cors());

/** Every error response: JSON, no upstream URLs or upstream bodies. */
function sendError(res: Response, e: unknown): void {
  if (e instanceof ApiError) {
    res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    return;
  }
  console.error("[unhandled]", e);
  res.status(500).json({ error: "Internal error", code: "internal_error" });
}

function singleParam(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function resolveAdapterDoc(): string | null {
  for (const p of [path.join(process.cwd(), "docs", "ADAPTER.md"), path.join(process.cwd(), "ADAPTER.md")]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get("/health", async (_req, res) => {
  try {
    const [block, pairs] = await Promise.all([getLatestBlock(), listPairs()]);
    res.json({
      ok: true,
      dexKey: DEX_KEY,
      factory: FACTORY,
      router: ROUTER,
      pairCount: pairs.length,
      ammPairCount: pairs.filter((p) => p.def.kind === "amm").length,
      bondingCurvePairCount: pairs.filter((p) => p.def.kind === "curve").length,
      latestBlock: block,
    });
  } catch (e) {
    sendError(res, e);
  }
});

app.get("/latest-block", async (_req, res) => {
  try {
    res.json({ block: await getLatestBlock() });
  } catch (e) {
    sendError(res, e);
  }
});

app.get("/asset", async (req, res) => {
  try {
    const id = singleParam(req.query.id);
    if (!id) throw new ApiError(400, "invalid_params", "Query param id is required");
    res.json({ asset: await getAsset(id) });
  } catch (e) {
    sendError(res, e);
  }
});

app.get("/pair", async (req, res) => {
  try {
    const id = singleParam(req.query.id);
    if (!id) throw new ApiError(400, "invalid_params", "Query param id is required");
    res.json({ pair: (await getPair(id)).pair });
  } catch (e) {
    sendError(res, e);
  }
});

/** Convenience listing (not part of the GT spec). */
app.get("/pairs", async (_req, res) => {
  try {
    const list = await listPairs();
    res.json({ pairs: list.map((p) => p.pair) });
  } catch (e) {
    sendError(res, e);
  }
});

app.get("/events", async (req, res) => {
  try {
    const { fromBlock, toBlock } = parseRange(req.query.fromBlock, req.query.toBlock);
    const events = await getEvents(fromBlock, toBlock);
    res.json({ events });
  } catch (e) {
    sendError(res, e);
  }
});

app.get(["/docs/ADAPTER.md", "/docs/adapter.md"], (_req, res) => {
  const docPath = resolveAdapterDoc();
  if (!docPath) {
    res.status(404).type("text/plain").send("ADAPTER.md not found in deployment");
    return;
  }
  res.type("text/markdown; charset=utf-8").send(fs.readFileSync(docPath, "utf8"));
});

app.get("/", (_req, res) => {
  res.json({
    name: "WESO DeFi GeckoTerminal Adapter API",
    chain: "Terra Classic (columbus-5)",
    geckoTerminalNetworkId: "terra",
    dexKey: DEX_KEY,
    factory: FACTORY,
    router: ROUTER,
    bondingCurves: BONDING_CURVES.map((c) => ({ id: c.id, reserveDenom: c.reserveDenom })),
    maxEventsBlockSpan: MAX_EVENTS_BLOCK_SPAN,
    endpoints: [
      "GET /latest-block",
      "GET /asset?id=",
      "GET /pair?id=",
      "GET /events?fromBlock=&toBlock=",
      "GET /pairs",
      "GET /health",
      "GET /docs/ADAPTER.md",
    ],
    docs: "/docs/ADAPTER.md",
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found", code: "not_found" });
});

export default app;

if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`WESO GT adapter listening on :${PORT} (dexKey=${DEX_KEY})`);
  });
}
