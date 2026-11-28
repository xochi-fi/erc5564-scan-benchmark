// Copies a built feed tree to a publish directory: each chain's manifest and only the pages it lists.
// Used by the feed workflow and to refresh data/feed/.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { manifestSchema, pagePath } from './format.ts';

export async function publishTree(from: string, to: string) {
  await rm(to, { recursive: true, force: true });
  const chains = existsSync(join(from, 'v1')) ? await readdir(join(from, 'v1')) : [];
  for (const chain of chains) {
    const src = join(from, 'v1', chain);
    if (!existsSync(join(src, 'manifest.json'))) continue;
    const manifest = manifestSchema.parse(await Bun.file(join(src, 'manifest.json')).json());
    const dst = join(to, 'v1', chain);
    await mkdir(join(dst, 'p'), { recursive: true });
    await cp(join(src, 'manifest.json'), join(dst, 'manifest.json'));
    for (const page of new Set(manifest.pages.map(pagePath))) await cp(join(src, page), join(dst, page));
  }
}

if (import.meta.main) {
  const [from, to] = Bun.argv.slice(2);
  if (!from || !to) throw new Error('Usage: bun run src/feed/publish.ts BUILT_TREE PUBLISH_DIR');
  await publishTree(from, to);
}
