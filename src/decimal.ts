/**
 * Exact decimal helpers built on BigInt. No floating point anywhere in the
 * amount / price / reserve pipeline.
 */

const UINT_RE = /^\d+$/;

export function isUintString(s: unknown): s is string {
  return typeof s === "string" && UINT_RE.test(s);
}

/** Parse a raw on-chain integer amount ("123") into a BigInt; throws on anything else. */
export function toBig(raw: string | bigint): bigint {
  if (typeof raw === "bigint") return raw;
  if (!isUintString(raw)) {
    throw new Error(`not an unsigned integer amount: ${JSON.stringify(raw)}`);
  }
  return BigInt(raw);
}

function trimFrac(whole: string, frac: string): string {
  const f = frac.replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole;
}

/** raw / 10^decimals rendered exactly, trailing zeros trimmed. Supports negatives. */
export function decimalize(raw: string | bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`invalid decimals ${decimals}`);
  }
  let v = typeof raw === "bigint" ? raw : toBig(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  let s = v.toString();
  if (decimals === 0) return (neg && s !== "0" ? "-" : "") + s;
  s = s.padStart(decimals + 1, "0");
  const out = trimFrac(s.slice(0, s.length - decimals), s.slice(s.length - decimals));
  return neg && out !== "0" ? `-${out}` : out;
}

/**
 * (numRaw / 10^numDec) / (denRaw / 10^denDec), truncated (round toward zero)
 * to `places` decimal places. Returns null if the denominator is zero.
 */
export function ratio(
  numRaw: bigint,
  numDec: number,
  denRaw: bigint,
  denDec: number,
  places = 50,
): string | null {
  if (denRaw === 0n) return null;
  if (numRaw < 0n || denRaw < 0n) throw new Error("ratio expects non-negative operands");
  // value = numRaw * 10^denDec / (denRaw * 10^numDec)
  const scaledNum = numRaw * 10n ** BigInt(denDec + places);
  const scaledDen = denRaw * 10n ** BigInt(numDec);
  const q = scaledNum / scaledDen; // truncation
  return decimalize(q, places);
}

/** Parse a non-negative decimal string ("0.002") into [mantissa, scale]. */
export function parseDecimal(s: string): { mantissa: bigint; scale: number } {
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`not a non-negative decimal: ${JSON.stringify(s)}`);
  }
  const [w, f = ""] = s.split(".");
  return { mantissa: BigInt(w + f), scale: f.length };
}

/** Convert a fee rate decimal ("0.002") to integer bps; throws if not an exact integer bps. */
export function rateToBps(rate: string): number {
  const { mantissa, scale } = parseDecimal(rate);
  const num = mantissa * 10000n;
  const den = 10n ** BigInt(scale);
  if (num % den !== 0n) throw new Error(`fee rate ${rate} is not an integer number of bps`);
  const bps = num / den;
  if (bps > 10000n) throw new Error(`fee rate ${rate} exceeds 100%`);
  return Number(bps);
}
