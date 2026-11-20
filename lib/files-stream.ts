/**
 * A stream name's bytes on a session thread of `ems-files`: what EiN's thread sends of the stream
 * node from the moment the name was opened, kept as a sliding window so the client's reads, which
 * come several at once and a little ahead of each other (sshfs reads ahead), are each answered
 * from it without a call back to EiN's thread.
 *
 * Offsets count from the open. A read is answered with what has come at its offset, as soon as
 * anything has, up to its length: a short read, as a pipe's. One for bytes that have not come yet
 * waits for them, up to `STALL_MS`; one past the window's end by more than the window, or for bytes
 * the window has let go (a reader that fell behind), and every read once the stream has ended and
 * its bytes are read, are answered as the end, after which the client opens the name again and is
 * given the stream from then on.
 */

/** What a window keeps behind its newest byte. */
const STREAM_WINDOW = 8 * 1024 * 1024;

/** How long a read waits for bytes before it is answered as the end. */
const STALL_MS = 20_000;

/** The most reads one stream's handle may have waiting; more are answered as the end. */
const MAX_WAITING = 64;

/**
 * The size a stream name says it has: one that never ends, so a client that reads no further than
 * the size it was told (the kernel, through sshfs) reads on.
 */
export const STREAM_SIZE = 2 ** 62;

type Waiting = { offset: number; wake: () => void };

export class StreamWindow {
  #chunks: Uint8Array[] = [];
  /** The offset of the first byte kept. */
  #base = 0;
  /** The offset past the last byte that has come. */
  #end = 0;
  #ended = false;
  #waiting = new Set<Waiting>();

  constructor(private readonly options: { window?: number; stallMs?: number } = {}) {}

  /** Bytes from EiN's thread; past the window, the oldest are let go. */
  push(data: Uint8Array): void {
    if (this.#ended || data.length === 0) return;
    this.#chunks.push(data);
    this.#end += data.length;
    const window = this.options.window ?? STREAM_WINDOW;
    while (this.#chunks.length > 1 && this.#end - this.#base - this.#chunks[0].length >= window) {
      this.#base += this.#chunks.shift()!.length;
    }
    for (const waiting of this.#waiting) if (waiting.offset < this.#end) waiting.wake();
  }

  /** No more comes: what is kept is still read, and then the end. */
  finish(): void {
    this.#ended = true;
    for (const waiting of this.#waiting) waiting.wake();
  }

  /** Up to `length` bytes at `offset`, or null for the end. */
  async read(offset: number, length: number): Promise<Uint8Array | null> {
    const window = this.options.window ?? STREAM_WINDOW;
    if (offset < this.#base || offset > this.#end + window) return null;
    if (offset >= this.#end) {
      if (this.#ended || this.#waiting.size >= MAX_WAITING) return null;
      const came = await new Promise<boolean>((resolve) => {
        const waiting: Waiting = {
          offset,
          wake: () => {
            clearTimeout(timer);
            this.#waiting.delete(waiting);
            resolve(true);
          },
        };
        const timer = setTimeout(() => {
          this.#waiting.delete(waiting);
          resolve(false);
        }, this.options.stallMs ?? STALL_MS);
        this.#waiting.add(waiting);
      });
      if (!came || offset < this.#base || offset >= this.#end) return null;
    }
    return this.#slice(offset, Math.min(offset + length, this.#end));
  }

  /** A copy of the bytes from `from` to `to`, both within the window. */
  #slice(from: number, to: number): Uint8Array {
    const out = new Uint8Array(to - from);
    let at = this.#base;
    for (const chunk of this.#chunks) {
      const start = Math.max(from, at);
      const stop = Math.min(to, at + chunk.length);
      if (start < stop) out.set(chunk.subarray(start - at, stop - at), start - from);
      at += chunk.length;
      if (at >= to) break;
    }
    return out;
  }
}
