// The two benchmark feeds as static files; `.json` makes CDNs compress them.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadReference } from './feed.ts';

export const STATIC_ROOT = 'data/shared-feed/static';
export const STATIC_FEEDS = ['tenderly', 'sentio'] as const;

if (import.meta.main) {
  const feed = await loadReference();
  await rm(STATIC_ROOT, { recursive: true, force: true });
  for (const [name, pages] of [[STATIC_FEEDS[0], feed.primary], [STATIC_FEEDS[1], feed.secondary]] as const) {
    await mkdir(join(STATIC_ROOT, name, feed.id), { recursive: true });
    await writeFile(join(STATIC_ROOT, name, 'manifest.json'), JSON.stringify(feed.manifest));
    for (const page of pages) await writeFile(join(STATIC_ROOT, name, feed.id, `${page.index}.json`), JSON.stringify(page));
  }
  console.log(`${STATIC_ROOT}: ${feed.primary.length} pages per feed, manifest ${feed.id}`);
}
