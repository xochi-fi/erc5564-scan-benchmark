/** Base windows and providers pinned by the RPC-recovery reference; the shared feed scans the same windows. */
export const scope = { chainId: "0x2105", start: 34_304_282, head: 46_544_281, pageBlocks: 1_000 };
export const rpc = {
  daybreak: "https://base.daybreak-rpc.network",
  tenderly: "https://base.gateway.tenderly.co",
  sentio: "https://base.rpc.sentio.xyz",
  pocket: "https://base.api.pocket.network",
};
export interface Window { from: number; to: number }
