import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import {
  BONDING_CURVES,
  DEX_KEY,
  FACTORY,
  LCD_URL,
  MAX_EVENTS_BLOCK_SPAN,
  PORT,
  ROUTER,
} from "./config.js";
import { getLatestBlock } from "./lcd.js";
import { getAsset } from "./assets.js";
import { getPair, listPairs } from "./pairs.js";
import { getEvents } from "./events.js";

const app = express();
app.use(cors());
app.use(express.json());

/** Resolve docs/ADAPTER.md from project root (local + Vercel includeFiles). */
function resolveAdapterDoc(): string | null {
  const candidates = [
    path.join(process.cwd(), "docs", "ADAPTER.md"),
    path.join(process.cwd(), "ADAPTER.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.get("/health", async (_req, res) => {
  try {
    const block = await getLatestBlock();
    const pairs = await listPairs();
    const ammCount = pairs.filter((p) => !p.bondingCurve).length;
    const curveCount = pairs.filter((p) => p.bondingCurve).length;
    res.json({
      ok: true,
      dexKey: DEX_KEY,
      factory: FACTORY,
      router: ROUTER,
      lcd: LCD_URL,
      pairCount: pairs.length,
      ammPairCount: ammCount,
      bondingCurvePairCount: curveCount,
      latestBlock: block,
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: (e as Error).message,
    });
  }
});

app.get("/latest-block", async (_req, res) => {
  try {
    const { blockNumber, blockTimestamp } = await getLatestBlock();
    res.json({
      block: { blockNumber, blockTimestamp },
    });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

app.get("/asset", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) {
      res.status(400).json({ error: "Query param id is required" });
      return;
    }
    const asset = await getAsset(id);
    res.json({ asset });
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.get("/pair", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) {
      res.status(400).json({ error: "Query param id is required" });
      return;
    }
    const resolved = await getPair(id);
    res.json({ pair: resolved.pair });
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status || 502).json({ error: err.message });
  }
});

/** Convenience: list included AMM + bonding-curve pairs (not required by GT). */
app.get("/pairs", async (_req, res) => {
  try {
    const list = await listPairs();
    res.json({
      pairs: list.map((p) => p.pair),
      excludedPairTypes: ["token_bonding", "converter"],
      bondingCurves: BONDING_CURVES.map((c) => c.id),
      note: "token_bonding factory types are wrap vaults (excluded); product curves $WESO/$reBASE are included",
    });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

app.get("/events", async (req, res) => {
  try {
    const fromBlock = Number(req.query.fromBlock);
    const toBlock = Number(req.query.toBlock);
    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
      res.status(400).json({
        error: "fromBlock and toBlock query params are required numbers",
      });
      return;
    }
    const events = await getEvents(fromBlock, toBlock);
    res.json({ events });
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status || 502).json({
      error: err.message,
      maxBlockSpan: MAX_EVENTS_BLOCK_SPAN,
    });
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
    dexKey: DEX_KEY,
    factory: FACTORY,
    router: ROUTER,
    bondingCurves: BONDING_CURVES.map((c) => ({
      id: c.id,
      reserveDenom: c.reserveDenom,
      symbol: c.symbol,
    })),
    endpoints: [
      "GET /health",
      "GET /latest-block",
      "GET /asset?id=",
      "GET /pair?id=",
      "GET /pairs",
      "GET /events?fromBlock=&toBlock=",
      "GET /docs/ADAPTER.md",
    ],
    docs: "/docs/ADAPTER.md",
  });
});

// Vercel serverless: export the Express app. Listen only when not on Vercel.
export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(
      `WESO GT adapter listening on :${PORT} (factory=${FACTORY.slice(0, 12)}… dexKey=${DEX_KEY} curves=${BONDING_CURVES.length})`,
    );
  });
}
