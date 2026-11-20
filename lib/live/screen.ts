/**
 * The MP4 a browser hands a screen near it, made from a stream node of fragmented MP4 as one reader
 * reads it: its header saying the stream lasts a while (`declared`), its fragments with their clock
 * starting at 0, and at once the fragments since the keyframe it joined at, filled out to a second
 * and to Chrome's next read (`quickStart`), so that Chrome has its metadata at once and offers the
 * screen.
 */

import { declared, Mp4Splitter, quickStart, rebased, videoTime } from './mp4.ts';
import type { Piece } from './piece.ts';

/** The part of a stream node's reading handle this reads through. */
export type ReadHandle = { read(size: number, signal?: AbortSignal): Promise<Uint8Array>; close(): Promise<void> };

const READ_CHUNK = 256 * 1024;

/** How long a read may wait for the fragments a joining reader is given at once, before what came is taken as all of them. */
const GATHER_MS = 30;

const isFragment = (piece: Piece): boolean => piece.bytes.length >= 8 && String.fromCharCode(...piece.bytes.subarray(4, 8)) === 'moof';

/** The stream `handle` reads, for a screen near a browser, saying it lasts `seconds`; cancelling it closes the handle. */
export const screenMp4 = (handle: ReadHandle, seconds: number): ReadableStream<Uint8Array> => {
  const splitter = new Mp4Splitter();
  const queue: Piece[] = [];
  let ended = false;
  /** Read once into the queue; false at the stream's end, or when `signal` aborts first. */
  const more = async (signal?: AbortSignal): Promise<boolean> => {
    let data: Uint8Array;
    try {
      data = await handle.read(READ_CHUNK, signal);
    } catch (error) {
      if (signal?.aborted) return false;
      throw error;
    }
    if (!data.length) {
      ended = true;
      return false;
    }
    queue.push(...splitter.feed(data));
    return true;
  };
  const next = async (): Promise<Piece | undefined> => {
    while (!queue.length) if (ended || !(await more())) return undefined;
    return queue.shift();
  };

  /** The header and the start, and how much earlier, in each track, the fragments after it are sent. */
  const opening = async (): Promise<{ start: Uint8Array[]; base: Map<number, number> } | undefined> => {
    let header: Uint8Array | undefined;
    let key: Piece | undefined;
    while (!key) {
      const piece = await next();
      if (!piece) return undefined;
      if (piece.kind === 'header') header = piece.bytes;
      else if (piece.kind === 'start' && header) key = piece;
    }
    while (await more(AbortSignal.timeout(GATHER_MS)));
    const fragments = [key.bytes];
    while (queue.length && isFragment(queue[0])) fragments.push(queue.shift()!.bytes);
    const base = videoTime(header!, fragments[0]);
    const { start, shift } = quickStart(declared(header!, seconds), fragments.map((fragment) => rebased(fragment, base)));
    return { start, base: new Map([...base].map(([track, value]) => [track, value - (shift.get(track) ?? 0)])) };
  };

  let base: Map<number, number> | undefined;
  const close = () => void handle.close().catch(() => {});
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        if (!base) {
          const opened = await opening();
          if (!opened) throw new Error('the stream ended');
          base = opened.base;
          for (const piece of opened.start) controller.enqueue(piece);
          return;
        }
        const piece = await next();
        if (!piece) throw new Error('the stream ended');
        controller.enqueue(isFragment(piece) ? rebased(piece.bytes, base) : piece.bytes);
      } catch {
        close();
        controller.close();
      }
    },
    cancel: close,
  });
};
