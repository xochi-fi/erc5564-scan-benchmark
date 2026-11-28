// Verify regenerated or reused fixture bytes against the original M1 digests.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateFixture } from '../shared/fixtures.ts';
import { readManifest } from './chain.ts';

export const SEED = 'erc5564-scan-v1';
export const MATCH_EVERY = 1000;
export const PINNED_SHA256: Record<string, string> = {
  '10000-sparse': 'c61558ae377ae549b38fa992f8434efe5dce68cfa4f0cb053e522e50eb8fb0d4',
  '10000-zero': '12d9d874235fde87f175495c1efef3bc184f1728833b23e77612b988624e75bf',
  '100000-sparse': '2a044dc056ebe274b19f90c5f83ca4833d25a8444e77e30149828e19d53ab29d',
  '100000-zero': '09812b7ff7f99293ec6def31daebfc2d100f414e4c0a77f9ab854c01a5802b42',
  '1000000-sparse': '40a91f155e86f9adaec03ae2defde58019c475b3acf549207f6c504bd4ca3104',
  '1000000-zero': 'c45698bd93baa934c4674788195564ef60a543f0fbfb08ba2aa5dcee1bc436ba',
};

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function verified(directory: string, name: string): Promise<boolean> {
  if (!(await exists(join(directory, 'manifest.json'))) || !(await exists(join(directory, 'announcements.jsonl')))) return false;
  const manifest = await readManifest(directory);
  const pinned = PINNED_SHA256[name];
  if (manifest.fixtureSha256 !== pinned || manifest.seed !== SEED) return false;
  return (await fileSha256(join(directory, 'announcements.jsonl'))) === pinned;
}

export async function prepare(name: string, output: string, reuse: readonly string[]): Promise<{ name: string; path: string; source: string }> {
  const pinned = PINNED_SHA256[name];
  const match = /^(\d+)-(zero|sparse)$/.exec(name);
  if (pinned === undefined || match?.[1] === undefined) throw new Error(`no pinned digest for fixture ${name}`);
  const target = join(output, name);
  if (await verified(target, name)) return { name, path: target, source: 'existing' };
  let candidate: string | null = null;
  for (const directory of reuse) {
    if (await exists(join(directory, name, 'announcements.jsonl'))) {
      candidate = join(directory, name);
      break;
    }
  }
  if (candidate !== null) {
    if (!(await verified(candidate, name))) {
      throw new Error(`reuse fixture ${candidate} does not match its manifest / the pinned SHA256 ${pinned}; refusing to continue`);
    }
    await mkdir(output, { recursive: true });
    await symlink(resolve(candidate), target);
    return { name, path: target, source: `reused ${resolve(candidate)} (SHA256 verified against manifest and pinned digest)` };
  }
  console.error(`generating ${name} (this can take a while for 1M)`);
  const manifest = await generateFixture(target, { count: Number(match[1]), seed: SEED, matchEvery: match[2] === 'zero' ? 0 : MATCH_EVERY });
  if (manifest.fixtureSha256 !== pinned || !(await verified(target, name))) {
    throw new Error(`regenerated ${name} differs from the pinned original (${manifest.fixtureSha256})`);
  }
  return { name, path: target, source: 'regenerated (byte-identical to pinned SHA256)' };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { output: { type: 'string' }, fixtures: { type: 'string' }, reuse: { type: 'string' } },
  });
  if (values.output === undefined || values.fixtures === undefined) throw new Error('--output and --fixtures are required');
  const results = [];
  for (const name of values.fixtures.split(',')) results.push(await prepare(name.trim(), resolve(values.output), (values.reuse ?? '').split(',').filter(Boolean)));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
