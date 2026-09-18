import type { AssetInfo } from "./types.js";

export function pairTypeKey(pairType: unknown): string {
  if (!pairType) return "";
  if (typeof pairType === "string") return pairType.toLowerCase();
  if (typeof pairType === "object") {
    const key = Object.keys(pairType as object)[0];
    if (
      key === "custom" &&
      typeof (pairType as { custom?: string }).custom === "string"
    ) {
      return (pairType as { custom: string }).custom.toLowerCase();
    }
    return (key || "").toLowerCase();
  }
  return "";
}

/** Canonical asset id for GT (CW20 = contract addr; native = denom). */
export function assetIdFromInfo(info: AssetInfo | undefined): string | null {
  if (!info) return null;
  if ("native_token" in info && info.native_token?.denom) {
    return info.native_token.denom;
  }
  if ("token" in info && info.token?.contract_addr) {
    return info.token.contract_addr;
  }
  return null;
}

/** Normalize wasm offer/ask asset attribute to our asset id. */
export function normalizeAssetAttr(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j.native || j.native_token) {
        return (j.native || j.native_token?.denom || j.native_token) as string;
      }
      if (j.cw20 || j.token) {
        return (j.cw20 || j.token?.contract_addr || j.token) as string;
      }
    } catch {
      /* fall through */
    }
  }
  return s;
}

export function decimalize(raw: string | number | bigint, decimals: number): string {
  const neg = false;
  let s = typeof raw === "bigint" ? raw.toString() : String(raw);
  if (!/^\d+$/.test(s)) {
    // already decimal or invalid — coerce carefully
    const n = Number(s);
    if (!Number.isFinite(n)) return "0";
    return trimZeros(n.toFixed(Math.min(50, Math.max(decimals, 18))));
  }
  const pad = decimals;
  if (s.length <= pad) {
    s = s.padStart(pad + 1, "0");
  }
  const whole = s.slice(0, s.length - pad) || "0";
  const frac = s.slice(s.length - pad).padEnd(pad, "0");
  const out = trimZeros(`${neg ? "-" : ""}${whole}.${frac}`);
  return out === "" || out === "." ? "0" : out;
}

function trimZeros(x: string): string {
  if (!x.includes(".")) return x;
  return x.replace(/\.?0+$/, "") || "0";
}

/** High-precision priceNative = asset1 per asset0; never return 0. */
export function priceNativeFromTrade(opts: {
  asset0In?: string;
  asset1Out?: string;
  asset1In?: string;
  asset0Out?: string;
  reserve0: string;
  reserve1: string;
}): string {
  const r0 = Number(opts.reserve0);
  const r1 = Number(opts.reserve1);
  let price: number | null = null;

  if (opts.asset0In && opts.asset1Out) {
    const a0 = Number(opts.asset0In);
    const a1 = Number(opts.asset1Out);
    if (a0 > 0 && a1 > 0) price = a1 / a0;
  } else if (opts.asset1In && opts.asset0Out) {
    const a1 = Number(opts.asset1In);
    const a0 = Number(opts.asset0Out);
    if (a0 > 0 && a1 > 0) price = a1 / a0;
  }

  if ((price == null || !(price > 0)) && r0 > 0 && r1 > 0) {
    price = r1 / r0;
  }

  if (price == null || !(price > 0) || !Number.isFinite(price)) {
    // Last resort: tiny positive to avoid GT halt — should be extremely rare.
    return "0.000000000000000001";
  }
  // Prefer string with many decimals for GT (up to 50).
  return price.toFixed(50).replace(/\.?0+$/, "") || String(price);
}

export function parseIsoToUnix(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor(t / 1000);
}

/** Split a flat wasm attribute list into per-contract sections. */
export function splitWasmSections(
  attributes: Array<{ key: string; value: string }>,
): Array<Record<string, string>> {
  const sections: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  for (const a of attributes) {
    const key = a.key;
    const value = a.value;
    if (key === "_contract_address" || key === "contract_address") {
      if (cur) sections.push(cur);
      cur = { _contract_address: value };
      continue;
    }
    if (!cur) cur = {};
    // Keep first occurrence for duplicates (e.g. multiple action=)
    if (!(key in cur)) cur[key] = value;
    else if (key === "action") {
      // Prefer swap / provide / withdraw over later actions in same blob
      /* keep first */
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

export function safeSymbol(...parts: Array<string | null | undefined>): string {
  const s = parts.filter(Boolean).join("/");
  return s || "UNKNOWN/UNKNOWN";
}
