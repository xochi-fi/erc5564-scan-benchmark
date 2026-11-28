// worker.js: runs the scan off the main thread. Says hello first so the page knows the worker started.
import { runScan, type PackedFixture } from './scan.ts';

interface Job { fixture: PackedFixture; engine: string; count: number; chunk: number }
const post = (message: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(message);
post({ type: 'hello' });

self.onmessage = async (event: MessageEvent<Job>) => {
  const { fixture, engine, count, chunk } = event.data;
  try {
    const r = await runScan(fixture, engine, count, chunk, done => post({ type: 'progress', done }));
    post({ type: 'done', scanMs: r.scanMs, matches: r.matches.length, expected: r.expected.length, verified: r.verified });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
