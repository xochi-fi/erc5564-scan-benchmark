// <chainId>.jsonl: the manifest, then each non-empty page body in manifest order.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_PAGE, manifestSchema, pagePath, sha256, type Manifest } from './format.ts';

export async function packTree(tree: string, out: string) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const chain of existsSync(join(tree, 'v1')) ? await readdir(join(tree, 'v1')) : []) {
    const dir = join(tree, 'v1', chain);
    if (!existsSync(join(dir, 'manifest.json'))) continue;
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
    const bodies = await Promise.all(manifest.pages.filter(page => page.count > 0).map(page => readFile(join(dir, pagePath(page)), 'utf8')));
    await writeFile(join(out, `${chain}.jsonl`), [JSON.stringify(manifest), ...bodies].join('\n') + '\n');
  }
}

export async function readPacked(file: string) {
  const [first, ...bodies] = (await readFile(file, 'utf8')).trim().split('\n');
  const manifest: Manifest = manifestSchema.parse(JSON.parse(first!));
  const pages = new Map<string, string>([[pagePath({ sha256: sha256(EMPTY_PAGE) }), EMPTY_PAGE]]);
  for (const body of bodies) pages.set(pagePath({ sha256: sha256(body) }), body);
  return { manifest, pages };
}

export async function unpackTree(packed: string, tree: string) {
  for (const file of (await readdir(packed)).filter(name => /^\d+\.jsonl$/.test(name))) {
    const { manifest, pages } = await readPacked(join(packed, file));
    const dir = join(tree, 'v1', String(manifest.chainId));
    await mkdir(join(dir, 'p'), { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
    for (const page of manifest.pages) {
      const body = pages.get(pagePath(page));
      if (body === undefined) throw new Error(`${file}: page ${page.from} missing`);
      await writeFile(join(dir, pagePath(page)), body);
    }
  }
}

if (import.meta.main) {
  const [command, from, to] = Bun.argv.slice(2);
  if (!from || !to || !['pack', 'unpack'].includes(command ?? '')) throw new Error('Usage: bun run src/feed/pack.ts pack|unpack FROM TO');
  await (command === 'pack' ? packTree(from, to) : unpackTree(from, to));
}
