import { Duplex } from "node:stream";

/**
 * Byte streams multiplexed over one WebSocket for the self-hosted T3 Connect
 * tunnel. One outbound connection per environment is all a locked-down
 * network has to allow, and requests share it instead of each paying a
 * handshake through a corporate proxy.
 *
 * Binary frame: [type u8][stream id u32 BE][payload]. Only the gateway opens
 * streams, so ids never collide. Text frames carry the JSON control messages
 * defined by the gateway and connector.
 */
const FRAME_OPEN = 1;
const FRAME_DATA = 2;
const FRAME_END = 3;
const FRAME_RESET = 4;
const FRAME_PAUSE = 5;
const FRAME_RESUME = 6;
const FRAME_HEADER_BYTES = 5;
const MAX_FRAME_PAYLOAD = 64 * 1024;
// A WebSocket has no drain event, so writers wait on this and poll.
const SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
const SOCKET_DRAIN_POLL_MS = 20;

export interface TunnelMuxSocket {
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
}

function encodeFrame(type: number, streamId: number, payload?: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + (payload?.byteLength ?? 0));
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, streamId);
  if (payload) frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

class MuxStream extends Duplex {
  localEnded = false;
  remoteEnded = false;
  remoteReset = false;
  #peerPaused = false;
  #pausedPeer = false;
  #pendingWrite: (() => void) | null = null;

  readonly id: number;
  private readonly mux: TunnelMux;

  constructor(id: number, mux: TunnelMux) {
    super({ allowHalfOpen: true });
    this.id = id;
    this.mux = mux;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    for (let offset = 0; offset < chunk.byteLength; offset += MAX_FRAME_PAYLOAD) {
      if (
        !this.mux.sendFrame(FRAME_DATA, this.id, chunk.subarray(offset, offset + MAX_FRAME_PAYLOAD))
      ) {
        callback(new Error("Tunnel connection closed"));
        return;
      }
    }
    const release = () => {
      this.#pendingWrite = null;
      callback();
    };
    if (this.#peerPaused || this.mux.socketCongested()) {
      this.#pendingWrite = release;
      this.mux.waitForDrain(this);
    } else {
      callback();
    }
  }

  override _final(callback: (error?: Error) => void) {
    this.localEnded = true;
    this.mux.sendFrame(FRAME_END, this.id);
    callback();
  }

  override _read() {
    if (this.#pausedPeer) {
      this.#pausedPeer = false;
      this.mux.sendFrame(FRAME_RESUME, this.id);
    }
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void) {
    if (!this.remoteReset && !(this.localEnded && this.remoteEnded)) {
      this.mux.sendFrame(FRAME_RESET, this.id);
    }
    this.mux.forget(this.id);
    callback(error);
  }

  receiveData(payload: Uint8Array) {
    if (!this.push(Buffer.from(payload)) && !this.#pausedPeer) {
      this.#pausedPeer = true;
      this.mux.sendFrame(FRAME_PAUSE, this.id);
    }
  }

  receiveEnd() {
    this.remoteEnded = true;
    this.push(null);
  }

  setPeerPaused(paused: boolean) {
    this.#peerPaused = paused;
    if (!paused) this.tryReleaseWrite();
  }

  /** True once nothing holds the pending write back. */
  tryReleaseWrite(): boolean {
    if (this.#pendingWrite === null) return true;
    if (this.#peerPaused || this.mux.socketCongested()) return false;
    this.#pendingWrite();
    return true;
  }
}

export class TunnelMux {
  readonly #socket: TunnelMuxSocket;
  readonly #onStream: ((stream: Duplex) => void) | undefined;
  readonly #streams = new Map<number, MuxStream>();
  readonly #blocked = new Set<MuxStream>();
  #drainTimer: ReturnType<typeof setInterval> | null = null;
  #nextStreamId = 1;
  #closed = false;

  constructor(
    socket: TunnelMuxSocket,
    options: { readonly onStream?: (stream: Duplex) => void } = {},
  ) {
    this.#socket = socket;
    this.#onStream = options.onStream;
  }

  get streamCount(): number {
    return this.#streams.size;
  }

  open(): Duplex {
    const stream = new MuxStream(this.#nextStreamId++, this);
    if (this.#nextStreamId > 0xffff_ffff) this.#nextStreamId = 1;
    this.#streams.set(stream.id, stream);
    if (!this.sendFrame(FRAME_OPEN, stream.id)) {
      stream.destroy(new Error("Tunnel connection closed"));
    }
    return stream;
  }

  /** Feed one binary WebSocket message. */
  receive(data: Uint8Array): void {
    if (data.byteLength < FRAME_HEADER_BYTES || this.#closed) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = view.getUint8(0);
    const streamId = view.getUint32(1);
    const payload = data.subarray(FRAME_HEADER_BYTES);
    if (type === FRAME_OPEN) {
      if (this.#onStream === undefined || this.#streams.has(streamId)) {
        this.sendFrame(FRAME_RESET, streamId);
        return;
      }
      const stream = new MuxStream(streamId, this);
      this.#streams.set(streamId, stream);
      this.#onStream(stream);
      return;
    }
    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      if (type !== FRAME_RESET) this.sendFrame(FRAME_RESET, streamId);
      return;
    }
    switch (type) {
      case FRAME_DATA:
        stream.receiveData(payload);
        return;
      case FRAME_END:
        stream.receiveEnd();
        return;
      case FRAME_RESET:
        stream.remoteReset = true;
        stream.destroy(new Error("Tunnel stream reset by peer"));
        return;
      case FRAME_PAUSE:
        stream.setPeerPaused(true);
        return;
      case FRAME_RESUME:
        stream.setPeerPaused(false);
        return;
    }
  }

  /** Destroys every stream; call when the WebSocket closes. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopDrainTimer();
    for (const stream of this.#streams.values()) {
      stream.remoteReset = true;
      stream.destroy(new Error("Tunnel connection closed"));
    }
    this.#streams.clear();
  }

  /** @internal */
  sendFrame(type: number, streamId: number, payload?: Uint8Array): boolean {
    if (this.#closed) return false;
    try {
      this.#socket.send(encodeFrame(type, streamId, payload));
      return true;
    } catch {
      return false;
    }
  }

  /** @internal */
  socketCongested(): boolean {
    return this.#socket.bufferedAmount > SOCKET_HIGH_WATER_BYTES;
  }

  /** @internal */
  waitForDrain(stream: MuxStream): void {
    this.#blocked.add(stream);
    this.#drainTimer ??= setInterval(() => {
      for (const blocked of this.#blocked) {
        if (blocked.tryReleaseWrite()) this.#blocked.delete(blocked);
      }
      if (this.#blocked.size === 0) this.#stopDrainTimer();
    }, SOCKET_DRAIN_POLL_MS);
  }

  /** @internal */
  forget(streamId: number): void {
    const stream = this.#streams.get(streamId);
    if (stream) this.#blocked.delete(stream);
    this.#streams.delete(streamId);
  }

  #stopDrainTimer() {
    if (this.#drainTimer !== null) {
      clearInterval(this.#drainTimer);
      this.#drainTimer = null;
    }
  }
}

/** Normalizes a WebSocket message payload; `null` for text frames. */
export function binaryMessageData(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data) && data.every((part) => ArrayBuffer.isView(part))) {
    return Buffer.concat(data as Array<Uint8Array>);
  }
  return null;
}
