import { BASE_CHAIN_ID, rpc as baseRpc } from '../shared/base-windows.ts';

export { filter, hex, identity, type LogIdentity } from '../shared/announcer.ts';

export const scope = {
  chainId: BASE_CHAIN_ID,
  start: 62_241_130,
  saved: 62_244_129,
  head: 62_246_129,
  pageBlocks: 500,
};
export const origin = 'http://127.0.0.1:8764';
export const rpc = {
  pocket: baseRpc.pocket,
  sentio: baseRpc.sentio,
  blockpi: 'https://base.public.blockpi.network/v1/rpc/public',
  base: 'https://mainnet.base.org',
  drpc: 'https://base.drpc.org',
  blockscout: 'https://base.blockscout.com/api/eth-rpc',
};
