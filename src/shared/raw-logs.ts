import { ERC5564AnnouncerAbi, type AnnouncementLog } from '@scopelift/stealth-address-sdk';
import { decodeEventLog, type Hex } from 'viem';
import { z } from 'zod';

export const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/);
export const rawLogSchema = z.object({
  address: hexString,
  blockHash: hexString,
  blockNumber: hexString,
  data: hexString,
  logIndex: hexString,
  removed: z.boolean().optional(),
  topics: z.array(hexString),
  transactionHash: hexString,
  transactionIndex: hexString,
}).passthrough();
export type RawLog = z.infer<typeof rawLogSchema>;
export const rawLogsSchema = z.array(rawLogSchema);
/** Decodes raw RPC logs into the SDK's AnnouncementLog shape (as the SDK's own getAnnouncements does). */
export function decodeAnnouncements(logs: RawLog[]): AnnouncementLog[] {
  return logs.map((log) => {
    const decoded = decodeEventLog({
      abi: ERC5564AnnouncerAbi,
      eventName: 'Announcement',
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    return {
      address: log.address as Hex,
      blockHash: log.blockHash as Hex,
      blockNumber: BigInt(log.blockNumber),
      data: log.data as Hex,
      logIndex: Number(BigInt(log.logIndex)),
      removed: log.removed ?? false,
      topics: log.topics as [Hex, ...Hex[]],
      transactionHash: log.transactionHash as Hex,
      transactionIndex: Number(BigInt(log.transactionIndex)),
      caller: decoded.args.caller,
      ephemeralPubKey: decoded.args.ephemeralPubKey,
      metadata: decoded.args.metadata,
      schemeId: decoded.args.schemeId,
      stealthAddress: decoded.args.stealthAddress,
    };
  });
}
