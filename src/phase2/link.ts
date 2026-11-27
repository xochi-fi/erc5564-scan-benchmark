import type { Socket } from 'bun';
import type { LinkCounters, LinkProfile } from './model.ts';

/** Writes to a Bun socket while honouring backpressure (partial writes). */
class SocketWriter {
  private pending: Uint8Array[] = [];
  private closed = false;

  constructor(private readonly socket: Socket<unknown>) {}

  write(data: Uint8Array): void {
    if (this.closed) return;
    if (this.pending.length > 0) {
      this.pending.push(data);
      return;
    }
    const written = this.socket.write(data);
    if (written < data.byteLength) this.pending.push(data.subarray(Math.max(written, 0)));
  }

  drain(): void {
    while (this.pending.length > 0 && !this.closed) {
      const next = this.pending[0];
      if (next === undefined) return;
      const written = this.socket.write(next);
      if (written < next.byteLength) {
        this.pending[0] = next.subarray(Math.max(written, 0));
        return;
      }
      this.pending.shift();
    }
  }

  close(): void {
    this.closed = true;
    this.pending = [];
  }
}

interface QueuedChunk {
  deliverAt: number;
  data: Uint8Array;
  sink: SocketWriter;
  after?: () => void;
}

// FIFO delivery time is max(arrival, linkFreeAt) + bytes / bandwidth + latency.
export class ShapedDirection {
  bytes = 0;
  private linkFreeAt = 0;
  private readonly queue: QueuedChunk[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly latencyMs: number,
    private readonly bytesPerSecond: number | null,
  ) {}

  get passthrough(): boolean {
    return this.latencyMs === 0 && this.bytesPerSecond === null;
  }

  push(data: Uint8Array, sink: SocketWriter): void {
    this.bytes += data.byteLength;
    if (this.passthrough) {
      sink.write(data);
      return;
    }
    const now = performance.now();
    const start = Math.max(now, this.linkFreeAt);
    const transmitMs = this.bytesPerSecond === null ? 0 : data.byteLength * 1000 / this.bytesPerSecond;
    this.linkFreeAt = start + transmitMs;
    // Copy: the runtime may reuse the receive buffer after the data callback returns.
    this.queue.push({ deliverAt: this.linkFreeAt + this.latencyMs, data: data.slice(), sink });
    this.schedule();
  }

  /** Runs `after` once every chunk queued before it has been delivered. */
  pushEnd(sink: SocketWriter, after: () => void): void {
    if (this.passthrough || this.queue.length === 0) {
      after();
      return;
    }
    const last = this.queue[this.queue.length - 1];
    this.queue.push({ deliverAt: last?.deliverAt ?? 0, data: new Uint8Array(0), sink, after });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) return;
    const head = this.queue[0];
    if (head === undefined) return;
    const delay = Math.max(0, head.deliverAt - performance.now());
    this.timer = setTimeout(() => this.flush(), delay);
  }

  private flush(): void {
    this.timer = null;
    const now = performance.now();
    // Absolute delivery times avoid accumulating timer drift.
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head === undefined || head.deliverAt > now + 0.05) break;
      this.queue.shift();
      if (head.data.byteLength > 0) head.sink.write(head.data);
      head.after?.();
    }
    this.schedule();
  }
}

export interface LinkEmulator {
  port: number;
  counters(): LinkCounters;
  stop(): void;
}

interface ClientState {
  writer: SocketWriter;
  upstream: Socket<unknown> | null;
  upstreamWriter: SocketWriter | null;
  buffered: Uint8Array[];
  closed: boolean;
}

// Count TCP payload bytes, including HTTP headers, through the shaped proxy.
export function startLinkEmulator(upstreamPort: number, profile: LinkProfile): LinkEmulator {
  const uplink = new ShapedDirection(profile.oneWayLatencyMs, profile.uplinkBytesPerSecond);
  const downlink = new ShapedDirection(profile.oneWayLatencyMs, profile.downlinkBytesPerSecond);
  let connections = 0;

  const listener = Bun.listen<ClientState>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        connections += 1;
        const state: ClientState = {
          writer: new SocketWriter(client as Socket<unknown>),
          upstream: null,
          upstreamWriter: null,
          buffered: [],
          closed: false,
        };
        client.data = state;
        Bun.connect<null>({
          hostname: '127.0.0.1',
          port: upstreamPort,
          socket: {
            open(upstream) {
              if (state.closed) {
                upstream.end();
                return;
              }
              state.upstream = upstream as Socket<unknown>;
              state.upstreamWriter = new SocketWriter(upstream as Socket<unknown>);
              for (const chunk of state.buffered) uplink.push(chunk, state.upstreamWriter);
              state.buffered = [];
            },
            data(_upstream, data) {
              downlink.push(data, state.writer);
            },
            drain() {
              state.upstreamWriter?.drain();
            },
            close() {
              state.upstreamWriter?.close();
              downlink.pushEnd(state.writer, () => {
                if (!state.closed) client.end();
              });
            },
            error(_upstream, error) {
              console.error('link emulator upstream error', error);
              client.end();
            },
          },
        }).catch((error: unknown) => {
          console.error('link emulator failed to connect upstream', error);
          client.end();
        });
      },
      data(client, data) {
        const state = client.data;
        if (state.upstreamWriter === null) {
          state.buffered.push(data.slice());
          return;
        }
        uplink.push(data, state.upstreamWriter);
      },
      drain(client) {
        client.data.writer.drain();
      },
      close(client) {
        const state = client.data;
        state.closed = true;
        state.writer.close();
        state.upstream?.end();
      },
      error(_client, error) {
        console.error('link emulator client error', error);
      },
    },
  });

  return {
    port: listener.port,
    counters: () => ({ connections, uplinkBytes: uplink.bytes, downlinkBytes: downlink.bytes }),
    stop: () => listener.stop(true),
  };
}
