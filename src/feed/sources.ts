// Sources that passed the chain-volume consistency check; spans are probed caps.
import type { FeedChain } from './format.ts';

export interface Source { name: string; url: string; span: number }
type Key = FeedChain['key'];
const WHOLE = 10_000_000;

export const SOURCES: Record<'a' | 'b', Record<Key, [Source, Source]>> = {
  a: {
    ethereum: [{ name: 'tenderly', url: 'https://gateway.tenderly.co/public/mainnet', span: WHOLE },
      { name: 'blockpi', url: 'https://ethereum.public.blockpi.network/v1/rpc/public', span: 5_000 }],
    base: [{ name: 'tenderly', url: 'https://base.gateway.tenderly.co', span: 1_000 },
      { name: 'pocket', url: 'https://base.api.pocket.network', span: 10_000 }],
    arbitrum: [{ name: 'tenderly', url: 'https://arbitrum.gateway.tenderly.co', span: WHOLE },
      { name: 'arbitrum.io', url: 'https://arb1.arbitrum.io/rpc', span: WHOLE }],
    optimism: [{ name: 'tenderly', url: 'https://optimism.gateway.tenderly.co', span: WHOLE },
      { name: 'optimism.io', url: 'https://mainnet.optimism.io', span: 10_000 }],
    gnosis: [{ name: 'gnosischain.com', url: 'https://rpc.gnosischain.com', span: WHOLE },
      { name: 'publicnode', url: 'https://gnosis-rpc.publicnode.com', span: 10_000 }],
    polygon: [{ name: 'tenderly', url: 'https://polygon.gateway.tenderly.co', span: WHOLE },
      { name: 'quicknode', url: 'https://rpc-mainnet.matic.quiknode.pro', span: 10_000 }],
    sepolia: [{ name: 'tenderly', url: 'https://sepolia.gateway.tenderly.co', span: WHOLE },
      { name: 'ethpandaops', url: 'https://rpc.sepolia.ethpandaops.io', span: 30_000 }],
  },
  b: {
    ethereum: [{ name: 'pocket', url: 'https://eth.api.pocket.network', span: 50_000 },
      { name: 'sentio', url: 'https://mainnet.rpc.sentio.xyz', span: 1_000 }],
    // thirdweb answers HTTP 429, so Pocket serves both feeds on Base.
    base: [{ name: 'sentio', url: 'https://base.rpc.sentio.xyz', span: 1_000 },
      { name: 'pocket', url: 'https://base.api.pocket.network', span: 10_000 }],
    arbitrum: [{ name: 'fastnode', url: 'https://public-arb-mainnet.fastnode.io', span: 250_000 },
      { name: 'pocket', url: 'https://arb-one.api.pocket.network', span: 10_000 }],
    optimism: [{ name: 'blockpi', url: 'https://optimism.public.blockpi.network/v1/rpc/public', span: 5_000 },
      { name: 'sentio', url: 'https://optimism.rpc.sentio.xyz', span: 1_000 }],
    gnosis: [{ name: 'oat.farm', url: 'https://gnosis.oat.farm', span: 10_000 },
      { name: 'pocket', url: 'https://gnosis.api.pocket.network', span: 10_000 }],
    polygon: [{ name: 'pocket', url: 'https://poly.api.pocket.network', span: 10_000 },
      { name: 'sentio', url: 'https://matic.rpc.sentio.xyz', span: 1_000 }],
    sepolia: [{ name: 'onfinality', url: 'https://eth-sepolia.api.onfinality.io/public', span: 1_000_000 },
      { name: '0xrpc', url: 'https://0xrpc.io/sep', span: 10_000 }],
  },
};
