export const ANNOUNCER = '0x55649e01b5df198d18d95b5cc5051630cfd45564';
export const ANNOUNCEMENT_TOPIC = '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7';

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
