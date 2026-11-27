import { ANNOUNCER, ANNOUNCEMENT_TOPIC } from '../chain-volume/rpc.ts';

export const scope = { chainId: "0x2105", start: 34_304_282, head: 46_544_281, pageBlocks: 1_000 };
export const origin = "http://127.0.0.1:8784";
export const control = "http://127.0.0.1:8785";
export const rpc = {
  daybreak: "https://base.daybreak-rpc.network",
  tenderly: "https://base.gateway.tenderly.co",
  sentio: "https://base.rpc.sentio.xyz",
  pocket: "https://base.api.pocket.network",
};
export interface Window { from: number; to: number }
export const chainVolumeIdentity = (id: string) => {
  const [block, , tx, index] = id.split(":");
  return [block, index, tx].join(":");
};
export const hex = (block: number) => `0x${block.toString(16)}`;
export const filter = (fromBlock: number, toBlock: number) => ({
  address: ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC],
  fromBlock: hex(fromBlock), toBlock: hex(toBlock),
});

export interface LogIdentity {
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
}
export function identity(log: LogIdentity): string {
  return [Number(log.blockNumber), log.blockHash.toLowerCase(),
    log.transactionHash.toLowerCase(), Number(log.logIndex)].join(':');
}
