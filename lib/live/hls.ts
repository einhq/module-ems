/**
 * A stream node of MPEG-TS as live HLS, what Safari hands an AirPlay screen: `index.m3u8`, a live
 * playlist (no end) of the latest `LISTED_SECONDS`, and its segments `index<n>.ts`, each from one
 * keyframe to the next with the stream's programme tables first. The node is read while players
 * ask for the files, and let go `LINGER_MS` after the last ask; the playlist asked for before the
 * first segment is made waits for it, up to `START_MS`, after which the asker is told to come back.
 */

import type { ServedFile } from '@ein/client';
import type { ReadHandle } from './screen.ts';
import { TsSplitter } from './ts.ts';

const PLAYLIST = 'index.m3u8';
const SEGMENT = /^index(\d{1,9})\.ts$/;

/** How much of the stream the playlist lists, in seconds. */
const LISTED_SECONDS = 10;

/** How long the playlist waits for its first segment. */
const START_MS = 10_000;

/** How long the node is read after the last file asked for. */
const LINGER_MS = 10_000;

const READ_CHUNK = 256 * 1024;

/** The 90 kHz clock's span, which a presentation time wraps at. */
const PTS_WRAP = 2 ** 33;

type Segment = { n: number; duration: number; bytes: Uint8Array<ArrayBuffer> };

const concat = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export class LiveHls {
  #segments: Segment[] = [];
  #sequence = 0;
  #header?: Uint8Array;
  #current?: { pts?: number; parts: Uint8Array[] };
  #reading?: Promise<ReadHandle | undefined>;
  #lastAsked = 0;
  #made = Promise.withResolvers<void>();
  #linger?: ReturnType<typeof setInterval>;
  #stopped = false;

  /** `open` opens the stream node to read. */
  constructor(private readonly open: () => Promise<ReadHandle>) {}

  /** The file `name`: the playlist, a segment it lists, or undefined for anything else. Throws while the first segment is not made. */
  async get(name: string): Promise<ServedFile | undefined> {
    const segment = SEGMENT.exec(name);
    if (name !== PLAYLIST && !segment) return undefined;
    if (this.#stopped) return undefined;
    this.#lastAsked = Date.now();
    this.#read();
    if (segment) {
      const found = this.#segments.find((each) => each.n === Number(segment[1]));
      return found ? { body: found.bytes, type: 'video/mp2t' } : undefined;
    }
    const deadline = Date.now() + START_MS;
    while (!this.#segments.length) {
      const left = deadline - Date.now();
      if (left <= 0 || this.#stopped) throw new Error('the stream has no segment yet');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.#made.promise, new Promise((resolve) => timer = setTimeout(resolve, left))]);
      clearTimeout(timer);
    }
    return { body: new TextEncoder().encode(this.#playlist()), type: 'application/vnd.apple.mpegurl' };
  }

  /** Stop reading, for good. */
  stop(): void {
    this.#stopped = true;
    this.#letGo();
  }

  #playlist(): string {
    const longest = Math.max(1, ...this.#segments.map((segment) => Math.ceil(segment.duration)));
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${longest}`,
      `#EXT-X-MEDIA-SEQUENCE:${this.#segments[0].n}`,
      ...this.#segments.flatMap((segment) => [`#EXTINF:${segment.duration.toFixed(3)},`, `index${segment.n}.ts`]),
      '',
    ].join('\n');
  }

  /** Read the node, unless it is read already. */
  #read(): void {
    if (this.#reading) return;
    const reading = this.#reading = this.open().then((handle) => {
      void this.#follow(handle, reading);
      return handle;
    }, () => {
      if (this.#reading === reading) this.#reading = undefined;
      return undefined;
    });
    this.#linger ??= setInterval(() => {
      if (Date.now() - this.#lastAsked > LINGER_MS) this.#letGo();
    }, 1_000);
  }

  async #follow(handle: ReadHandle, reading: Promise<ReadHandle | undefined>): Promise<void> {
    const splitter = new TsSplitter();
    try {
      while (this.#reading === reading) {
        const data = await handle.read(READ_CHUNK);
        if (!data.length) break;
        for (const piece of splitter.feed(data)) {
          if (piece.kind === 'header') this.#header = piece.bytes;
          else if (piece.kind === 'start') {
            if (this.#current) this.#cut(piece.pts);
            this.#current = { pts: piece.pts, parts: [piece.bytes] };
          } else this.#current?.parts.push(piece.bytes);
        }
      }
    } catch {
      // Closed as it was let go, or the stream failed: either way it is read no more.
    }
    await handle.close().catch(() => {});
    if (this.#reading === reading) this.#reading = undefined;
  }

  /** The segment being made, made: up to the keyframe at `next`, with the stream's tables first. */
  #cut(next: number | undefined): void {
    const current = this.#current!;
    const duration = current.pts !== undefined && next !== undefined ? ((next - current.pts + PTS_WRAP) % PTS_WRAP) / 90_000 : 1;
    this.#segments.push({ n: this.#sequence++, duration, bytes: concat([...(this.#header ? [this.#header] : []), ...current.parts]) });
    while (this.#segments.length > 1 && this.#segments.reduce((total, segment) => total + segment.duration, 0) > LISTED_SECONDS) this.#segments.shift();
    this.#made.resolve();
    this.#made = Promise.withResolvers<void>();
  }

  /** The node let go of, and what was made of it with it; asked again, it is read anew. */
  #letGo(): void {
    clearInterval(this.#linger);
    this.#linger = undefined;
    const reading = this.#reading;
    this.#reading = undefined;
    void reading?.then((handle) => handle?.close().catch(() => {}));
    this.#segments = [];
    this.#current = undefined;
    this.#made.resolve();
    this.#made = Promise.withResolvers<void>();
  }
}
