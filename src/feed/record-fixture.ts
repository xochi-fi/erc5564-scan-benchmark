// Live, keyless: records the RPC exchanges behind test/fixtures/feed and builds both fixture feeds.
import { rm, writeFile } from 'node:fs/promises';
import { PoliteHttp, type Transport } from '../chain-volume/http.ts';
import { buildFeedA } from './build-a.ts';
import { buildFeedB, type Post } from './build-b.ts';
import { FIXTURE_DIR, FIXTURE_TARGET, FIXTURE_TIME, type Exchange } from './fixture.ts';
import { SOURCES } from './sources.ts';

const exchanges: Exchange[] = [];
const http = new PoliteHttp({ minIntervalMs: 250 });
const transport: Transport = {
  async request(url, init) {
    const result = await http.request(url, init);
    exchanges.push({ url, request: init.body ?? '', status: result.status, text: result.text });
    return result;
  },
};
const post: Post = async (url, body) => {
  const result = await http.request(url, { method: 'POST', body });
  exchanges.push({ url, request: body, status: result.status, text: result.text });
  return { status: result.status, text: result.text };
};
const sources = { gnosis: SOURCES.a.gnosis };
await rm(`${FIXTURE_DIR}/a`, { recursive: true, force: true });
await rm(`${FIXTURE_DIR}/b`, { recursive: true, force: true });
const a = await buildFeedA({ feed: 'a', transport, chains: [FIXTURE_TARGET], sources, outDir: `${FIXTURE_DIR}/a`, now: () => FIXTURE_TIME });
const b = await buildFeedB({ post, chains: [FIXTURE_TARGET], sources: { gnosis: SOURCES.b.gnosis }, outDir: `${FIXTURE_DIR}/b`, now: () => FIXTURE_TIME });
console.log(JSON.stringify({ a, b }, null, 1));
await writeFile(`${FIXTURE_DIR}/rpc.json`, JSON.stringify({ recordedAt: new Date().toISOString(), target: FIXTURE_TARGET, exchanges }, null, 1) + '\n');
await writeFile(`${FIXTURE_DIR}/targets.json`, JSON.stringify([FIXTURE_TARGET]) + '\n');
