export type AssetInfo =
  | { native_token: { denom: string } }
  | { token: { contract_addr: string } };

export interface FactoryPair {
  asset_infos: AssetInfo[];
  contract_addr: string;
  liquidity_token?: string;
  asset_decimals?: number[];
  pair_type?: unknown;
}

export interface PoolAsset {
  info: AssetInfo;
  amount: string;
}

export interface Block {
  blockNumber: number;
  blockTimestamp: number;
  metadata?: Record<string, string>;
}

export interface Asset {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply?: string | number;
  circulatingSupply?: string | number;
  coinGeckoId?: string;
  metadata?: Record<string, string>;
}

export interface Pair {
  id: string;
  dexKey: string;
  asset0Id: string;
  asset1Id: string;
  /** Non-empty display name — GT halts on empty pair names. */
  name: string;
  createdAtBlockNumber?: number;
  createdAtBlockTimestamp?: number;
  createdAtTxnId?: string;
  creator?: string;
  feeBps?: number;
  metadata?: Record<string, string>;
}

export interface SwapEvent {
  eventType: "swap";
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  maker: string;
  pairId: string;
  asset0In?: number | string;
  asset1In?: number | string;
  asset0Out?: number | string;
  asset1Out?: number | string;
  priceNative: number | string;
  reserves: { asset0: number | string; asset1: number | string };
  metadata?: Record<string, string | number>;
}

export interface JoinExitEvent {
  eventType: "join" | "exit";
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  maker: string;
  pairId: string;
  amount0: number | string;
  amount1: number | string;
  reserves: { asset0: number | string; asset1: number | string };
  metadata?: Record<string, string>;
}

export type IndexedEvent = { block: Block } & (SwapEvent | JoinExitEvent);
