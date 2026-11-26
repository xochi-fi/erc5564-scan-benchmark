import { z } from 'zod';

export interface ChainConfig {
  key: string;
  chainId: number;
  name: string;
  /** Blockscout instances to try, in order (some redirect or sit behind Cloudflare). */
  blockscout: string[];
  /** Routescan etherscan-compatible base, when Routescan reports the chain as supported. */
  routescan: string | null;
  /** Rough seconds per block, for the per-month rate only. */
  blockSeconds: number;
}

export const CHAINS: ChainConfig[] = [
  { key: 'ethereum', chainId: 1, name: 'Ethereum', blockscout: ['https://eth.blockscout.com'], routescan: 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api', blockSeconds: 12 },
  { key: 'base', chainId: 8453, name: 'Base', blockscout: ['https://base.blockscout.com'], routescan: null, blockSeconds: 2 },
  { key: 'arbitrum', chainId: 42161, name: 'Arbitrum One', blockscout: ['https://arbitrum.blockscout.com'], routescan: null, blockSeconds: 0.25 },
  { key: 'optimism', chainId: 10, name: 'OP Mainnet', blockscout: ['https://explorer.optimism.io', 'https://optimism.blockscout.com'], routescan: null, blockSeconds: 2 },
  { key: 'gnosis', chainId: 100, name: 'Gnosis', blockscout: ['https://gnosis.blockscout.com'], routescan: null, blockSeconds: 5 },
  { key: 'polygon', chainId: 137, name: 'Polygon PoS', blockscout: ['https://polygon.blockscout.com'], routescan: null, blockSeconds: 2 },
  { key: 'sepolia', chainId: 11155111, name: 'Sepolia', blockscout: ['https://eth-sepolia.blockscout.com'], routescan: 'https://api.routescan.io/v2/network/testnet/evm/11155111/etherscan/api', blockSeconds: 12 },
];

export function chainByKey(key: string): ChainConfig {
  const chain = CHAINS.find(candidate => candidate.key === key);
  if (chain === undefined) throw new Error(`unknown chain ${key}; known: ${CHAINS.map(c => c.key).join(', ')}`);
  return chain;
}

const chainlistSchema = z.array(z.object({
  chainId: z.number(),
  name: z.string(),
  rpc: z.array(z.union([z.string(), z.object({ url: z.string(), tracking: z.string().optional() }).passthrough()])),
}).passthrough());

export interface EndpointCandidate {
  url: string;
  tracking: string | null;
  excluded: string | null;   // reason, or null when it will be probed
}

/** MEV-protection / transaction-relay endpoints: listed as RPCs, but built to submit transactions. */
const RELAY_HOSTS = /(flashbots\.net|mevblocker\.io|blxrbdn\.com|blocknative\.com|securerpc\.com|blockrazor\.xyz|mev-x\.com|fullsend\.to|backrun\.io|merkle\.io)$/i;

/**
 * Decides whether a chainlist URL counts as "free and keyless". A URL that carries
 * a key in its query or a key-shaped path segment (even a published demo key)
 * is excluded: the study uses no API keys at all.
 */
export function endpointExclusion(url: string): string | null {
  if (!url.startsWith('https://')) return url.startsWith('wss://') || url.startsWith('ws://') ? 'websocket' : 'not https';
  if (url.includes('${')) return 'template needs a key';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unparseable';
  }
  if ([...parsed.searchParams.keys()].some(key => /key|token|auth|secret/i.test(key))) return 'key in query string';
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.some(segment => /^[0-9a-f]{24,}$/i.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || /^[A-Za-z0-9_-]{30,}$/.test(segment))) {
    return 'key-shaped path segment';
  }
  if (segments.some(segment => /^(demo|vk_demo)$/i.test(segment))) return 'demo key in path';
  if (/^virtual\./.test(parsed.host)) return 'private virtual testnet';
  if (/buildbear\.io$/.test(parsed.host)) return 'private sandbox fork';
  if (RELAY_HOSTS.test(parsed.host)) return 'transaction relay / MEV endpoint';
  return null;
}

export function endpointsFromChainlist(json: unknown, chainId: number): EndpointCandidate[] {
  const list = chainlistSchema.parse(json);
  const entry = list.find(chain => chain.chainId === chainId);
  if (entry === undefined) return [];
  const seen = new Set<string>();
  const out: EndpointCandidate[] = [];
  for (const rpc of entry.rpc) {
    const url = (typeof rpc === 'string' ? rpc : rpc.url).replace(/\/+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, tracking: typeof rpc === 'string' ? null : rpc.tracking ?? null, excluded: endpointExclusion(url) });
  }
  return out;
}
