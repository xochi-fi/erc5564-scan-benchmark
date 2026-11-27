import { ANNOUNCER, ANNOUNCEMENT_TOPIC } from '../../src/phase3/rpc.ts';

export const scope = {
  chainId: '0x2105',
  start: 62_241_130,
  saved: 62_244_129,
  head: 62_246_129,
  pageBlocks: 500,
};
export const origin = 'http://127.0.0.1:8764';
export const rpc = {
  pocket: 'https://base.api.pocket.network',
  sentio: 'https://base.rpc.sentio.xyz',
  blockpi: 'https://base.public.blockpi.network/v1/rpc/public',
  base: 'https://mainnet.base.org',
  drpc: 'https://base.drpc.org',
  blockscout: 'https://base.blockscout.com/api/eth-rpc',
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
