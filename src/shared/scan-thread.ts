// Bun worker thread for the multi-threaded scan: holds one contiguous slice and scans it on request.
import { curveFor, scanRange, type FastEngine, type ScanInput } from './engines.ts';
import type { Recipient } from './model.ts';

declare const self: Worker;

let slice: ScanInput[] = [];
let offset = 0;
let recipient: Recipient | undefined;
let engine: FastEngine | undefined;

self.onmessage = (event: MessageEvent) => {
  const message = event.data as
    | { type: 'load'; engine: FastEngine; recipient: Recipient; offset: number; announcements: ScanInput[] }
    | { type: 'scan' };
  try {
    if (message.type === 'load') {
      ({ engine, recipient, offset } = message);
      slice = message.announcements;
      curveFor(engine);
      self.postMessage({ type: 'ready' });
      return;
    }
    if (engine === undefined || recipient === undefined) throw new Error('scan before load');
    const local: number[] = [];
    scanRange(curveFor(engine), slice, recipient, 0, slice.length, local);
    self.postMessage({ type: 'done', indices: local.map(index => index + offset) });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
