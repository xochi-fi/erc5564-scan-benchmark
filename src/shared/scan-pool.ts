// Multi-threaded scan: one Bun worker per contiguous slice. Loading the slices into the workers
// happens in `startPool`, outside the scan timer; `scan` posts one message per worker and waits.
import type { AnnouncementLog } from '@scopelift/stealth-address-sdk';
import type { FastEngine, ScanInput } from './engines.ts';
import type { Recipient } from './model.ts';

type Reply = { type: 'ready' } | { type: 'done'; indices: number[] } | { type: 'error'; message: string };

function request(worker: Worker, message: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const reply = event.data as Reply;
      if (reply.type === 'error') reject(new Error(`scan thread failed: ${reply.message}`));
      else resolve(reply);
    };
    worker.onerror = (event) => reject(new Error(`scan thread error: ${event.message}`));
    worker.postMessage(message);
  });
}

export interface ScanPool {
  scan(): Promise<number[]>;
  close(): void;
}

export async function startPool(
  engine: FastEngine,
  threads: number,
  announcements: readonly AnnouncementLog[],
  recipient: Recipient,
): Promise<ScanPool> {
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error('threads must be a positive integer');
  const size = Math.ceil(announcements.length / threads);
  const workers = Array.from({ length: threads }, () => new Worker(new URL('./scan-thread.ts', import.meta.url).href));
  try {
    await Promise.all(workers.map((worker, i) => {
      const slice: ScanInput[] = announcements.slice(i * size, (i + 1) * size)
        .map(({ ephemeralPubKey, metadata, stealthAddress, schemeId }) => ({ ephemeralPubKey, metadata, stealthAddress, schemeId }));
      return request(worker, { type: 'load', engine, recipient, offset: i * size, announcements: slice });
    }));
  } catch (error) {
    for (const worker of workers) worker.terminate();
    throw error;
  }
  return {
    async scan() {
      const replies = await Promise.all(workers.map(worker => request(worker, { type: 'scan' })));
      return replies.flatMap(reply => (reply.type === 'done' ? reply.indices : []));
    },
    close() {
      for (const worker of workers) worker.terminate();
    },
  };
}
