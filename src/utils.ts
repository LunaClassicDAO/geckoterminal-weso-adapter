import type { AssetInfo } from "./types.js";

export function pairTypeKey(pairType: unknown): string {
  if (!pairType) return "";
  if (typeof pairType === "string") return pairType.toLowerCase();
  if (typeof pairType === "object") {
    const key = Object.keys(pairType as object)[0];
    if (key === "custom" && typeof (pairType as { custom?: string }).custom === "string") {
      return (pairType as { custom: string }).custom.toLowerCase();
    }
    return (key || "").toLowerCase();
  }
  return "";
}

/** Canonical asset id for GT (CW20 = contract addr; native = denom). */
export function assetIdFromInfo(info: AssetInfo | undefined): string | null {
  if (!info) return null;
  if ("native_token" in info && info.native_token?.denom) return info.native_token.denom;
  if ("token" in info && info.token?.contract_addr) return info.token.contract_addr;
  return null;
}
