// Checks two erc5564-feed/1 trees (directories or base URLs) against the spec and against each other.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readPacked } from './pack.ts';
import { agree, checkManifest, decodePage, FEED_CHAINS, manifestSchema, pagePath, sha256, type Fetch, type Manifest } from './format.ts';

export interface VerifyTarget { key: string; chainId: number; deployBlock: number }

export function reader(root: string): (chainId: number) => Fetch {
  if (/^https?:\/\//.test(root)) {
    return chainId => async path => {
      const response = await fetch(new URL(`v1/${chainId}/${path}`, root.endsWith('/') ? root : root + '/'),
        { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.url} HTTP ${response.status}`);
      return response.text();
    };
  }
  // A packed directory (see pack.ts) holds <chainId>.jsonl instead of a tree.
  return chainId => {
    const packed = join(root, `${chainId}.jsonl`);
    if (!existsSync(packed)) return path => readFile(join(root, 'v1', String(chainId), path), 'utf8');
    const loaded = readPacked(packed);
    return async path => {
      const { manifest, pages } = await loaded;
      const body = path === 'manifest.json' ? JSON.stringify(manifest) : pages.get(path);
      if (body === undefined) throw new Error(`${packed}: no ${path}`);
      return body;
    };
  };
}

const count = (manifest: Manifest) => manifest.pages.reduce((sum, page) => sum + page.count, 0);
async function verifyPages(target: VerifyTarget, manifest: Manifest, fetch: Fetch) {
  checkManifest(manifest, target.chainId, target.deployBlock);
  for (const page of manifest.pages) {
    if (!page.count) continue;
    const body = await fetch(pagePath(page));
    if (sha256(body) !== page.sha256) throw new Error(`${target.key}: page ${page.from} digest mismatch`);
    if (decodePage(body, page.from, page.to).length !== page.count) throw new Error(`${target.key}: page ${page.from} count mismatch`);
  }
}

export async function verifyFeeds(rootA: string, rootB: string, targets: readonly VerifyTarget[]) {
  const [readA, readB] = [reader(rootA), reader(rootB)];
  return Promise.all(targets.map(async target => {
    const fetchA = readA(target.chainId);
    const fetchB = readB(target.chainId);
    const [a, b] = await Promise.all([fetchA, fetchB].map(async fetch => {
      const text = await fetch('manifest.json').catch(() => null);
      return text === null ? null : manifestSchema.parse(JSON.parse(text));
    }));
    // A chain one feed has not published yet is pending, not a disagreement.
    if (!a || !b) {
      for (const [manifest, fetch] of [[a, fetchA], [b, fetchB]] as const) {
        if (manifest) await verifyPages(target, manifest, fetch);
      }
      return { chain: target.key, chainId: target.chainId, finalized: [a?.finalized.number ?? null, b?.finalized.number ?? null],
        announcements: [a ? count(a) : null, b ? count(b) : null], agreedTo: null, agreedAnnouncements: null, disagreement: null,
        pending: true };
    }
    // Every page of each feed must match its own digest and decode canonically, not only the agreed ones.
    await verifyPages(target, a, fetchA);
    await verifyPages(target, b, fetchB);
    const result = await agree(a, b, fetchA, fetchB);
    return {
      chain: target.key, chainId: target.chainId, finalized: [a.finalized.number, b.finalized.number],
      announcements: [count(a), count(b)], agreedTo: result.agreedTo, agreedAnnouncements: result.rows.length,
      disagreement: result.disagreement, pending: false,
    };
  }));
}

if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { targets: { type: 'string' }, chains: { type: 'string' } } });
  const [rootA, rootB] = positionals;
  if (!rootA || !rootB) throw new Error('Usage: bun run feed:verify FEED_A FEED_B [--chains a,b] [--targets JSON]');
  const all: VerifyTarget[] = values.targets ? JSON.parse(await readFile(values.targets, 'utf8')) : [...FEED_CHAINS];
  const keys = values.chains?.split(',');
  const results = await verifyFeeds(rootA, rootB, all.filter(target => !keys || keys.includes(target.key)));
  console.log(JSON.stringify(results, null, 1));
  const behind = results.filter(result => result.disagreement !== null);
  if (behind.length) {
    console.error(`Feeds disagree on ${behind.map(result => result.chain).join(', ')}`);
    process.exitCode = 2;
  }
}
