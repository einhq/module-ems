/**
 * Fragmented MP4 as a live stream carries it: cut into its header (`ftyp` and `moov`) and its
 * fragments (`moof` and `mdat` together), each told whether it starts at a keyframe; and the
 * changes a reader of it may want: each track's decode time moved (`rebased`), the header saying
 * the stream lasts a while (`declared`), and a start that holds a second at once (`quickStart`).
 */

import type { Piece } from './piece.ts';

const NON_SYNC = 0x10000;

/** How much media a quick start holds at once: Chrome reads a stream's metadata once it has about a second. */
const QUICK_START_SECONDS = 1;

/** Chrome fills its reads of a stream this many bytes at a time. */
const CHROME_READ = 32 * 1024;

const ascii = (data: Uint8Array, at: number): string => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);

const view = (data: Uint8Array): DataView => new DataView(data.buffer, data.byteOffset, data.byteLength);

const u32 = (data: Uint8Array, at: number): number => view(data).getUint32(at);

/** A box's size, its 64-bit one when its 32-bit one is 1; 0 when there are too few bytes to tell. */
const boxSize = (data: Uint8Array, at: number): number => {
  const size = u32(data, at);
  if (size !== 1) return size;
  return at + 16 <= data.length ? Number(view(data).getBigUint64(at + 8)) : 0;
};

/** Each box in `data` from `start` to `end`: its type, offset and size. */
function* boxes(data: Uint8Array, start: number, end: number): Generator<[string, number, number]> {
  let at = start;
  while (at + 8 <= end) {
    const size = boxSize(data, at);
    if (size < 8 || at + size > end) return;
    yield [ascii(data, at + 4), at, size];
    at += size;
  }
}

/** The first child of type `kind` of the box at `offset`, as its offset and size. */
const child = (data: Uint8Array, offset: number, size: number, kind: string): [number, number] | undefined => {
  for (const [found, at, length] of boxes(data, offset + 8, offset + size)) if (found === kind) return [at, length];
  return undefined;
};

const top = (data: Uint8Array, kind: string): [number, number] | undefined => {
  for (const [found, at, size] of boxes(data, 0, data.length)) if (found === kind) return [at, size];
  return undefined;
};

const flagsOf = (data: Uint8Array, box: number): number => u32(data, box + 8) & 0xffffff;

/**
 * Whether a fragment's first sample is a keyframe, given its `moof`: its `trun`'s first-sample or
 * first sample's flags, else its `tfhd`'s default, without the non-sync bit.
 */
const fragmentIsKey = (moof: Uint8Array): boolean => {
  const traf = child(moof, 0, moof.length, 'traf');
  if (!traf) return false;
  let fallback: number | undefined;
  const tfhd = child(moof, ...traf, 'tfhd');
  if (tfhd) {
    const flags = flagsOf(moof, tfhd[0]);
    let at = tfhd[0] + 16;
    for (const [bit, width] of [[0x1, 8], [0x2, 4], [0x8, 4], [0x10, 4]]) if (flags & bit) at += width;
    if (flags & 0x20) fallback = u32(moof, at);
  }
  const trun = child(moof, ...traf, 'trun');
  if (!trun) return false;
  const flags = flagsOf(moof, trun[0]);
  let at = trun[0] + 16;
  if (flags & 0x1) at += 4;
  if (flags & 0x4) return !(u32(moof, at) & NON_SYNC);
  if (flags & 0x400) {
    at += (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0);
    return !(u32(moof, at) & NON_SYNC);
  }
  return fallback !== undefined && !(fallback & NON_SYNC);
};

/** A track of the MP4 header: its timescale, whether it is the picture, and its `trex`'s default sample duration. */
type Track = { timescale: number; video: boolean; defaultDuration?: number };

/** The header's tracks, by track id. */
export const tracks = (header: Uint8Array): Map<number, Track> => {
  const found = new Map<number, Track>();
  const moov = top(header, 'moov');
  if (!moov) return found;
  const defaults = new Map<number, number>();
  const mvex = child(header, ...moov, 'mvex');
  if (mvex) {
    for (const [kind, at] of boxes(header, mvex[0] + 8, mvex[0] + mvex[1])) {
      if (kind === 'trex') defaults.set(u32(header, at + 12), u32(header, at + 20));
    }
  }
  for (const [kind, at, size] of boxes(header, moov[0] + 8, moov[0] + moov[1])) {
    if (kind !== 'trak') continue;
    const tkhd = child(header, at, size, 'tkhd');
    const mdia = child(header, at, size, 'mdia');
    const mdhd = mdia ? child(header, ...mdia, 'mdhd') : undefined;
    const hdlr = mdia ? child(header, ...mdia, 'hdlr') : undefined;
    if (!tkhd || !mdhd) continue;
    const trackId = u32(header, tkhd[0] + (header[tkhd[0] + 8] === 1 ? 28 : 20));
    const timescale = u32(header, mdhd[0] + (header[mdhd[0] + 8] === 1 ? 28 : 20));
    found.set(trackId, { timescale, video: hdlr !== undefined && ascii(header, hdlr[0] + 16) === 'vide', defaultDuration: defaults.get(trackId) });
  }
  return found;
};

/** Each `traf` of a fragment's `moof`: its track id, offset and size. */
const trafs = (fragment: Uint8Array): [number, number, number][] => {
  const moof = top(fragment, 'moof');
  if (!moof) return [];
  const found: [number, number, number][] = [];
  for (const [kind, at, size] of boxes(fragment, moof[0] + 8, moof[0] + moof[1])) {
    const tfhd = kind === 'traf' ? child(fragment, at, size, 'tfhd') : undefined;
    if (tfhd) found.push([u32(fragment, tfhd[0] + 12), at, size]);
  }
  return found;
};

/** Where each track's decode time is in a fragment, and its width in bytes. */
const tfdts = (fragment: Uint8Array): Map<number, [number, number]> => {
  const found = new Map<number, [number, number]>();
  for (const [trackId, at, size] of trafs(fragment)) {
    const tfdt = child(fragment, at, size, 'tfdt');
    if (tfdt) found.set(trackId, [tfdt[0] + 12, fragment[tfdt[0] + 8] === 1 ? 8 : 4]);
  }
  return found;
};

/** Each track's decode time in a fragment, in the track's timescale. */
export const decodeTimes = (fragment: Uint8Array): Map<number, number> =>
  new Map([...tfdts(fragment)].map(([trackId, [at, width]]) => [trackId, width === 8 ? Number(view(fragment).getBigUint64(at)) : u32(fragment, at)]));

/** A copy of the fragment with the decode times `times` gives its tracks; the others as they were. */
export const atDecodeTimes = (fragment: Uint8Array, times: Map<number, number>): Uint8Array => {
  const out = fragment.slice();
  for (const [trackId, [at, width]] of tfdts(fragment)) {
    const time = times.get(trackId);
    if (time === undefined) continue;
    if (width === 8) view(out).setBigUint64(at, BigInt(Math.max(0, time)));
    else view(out).setUint32(at, Math.max(0, time));
  }
  return out;
};

/** `value` in the timescale of track `trackId`, as the same time in every track's. */
const sameTime = (header: Uint8Array, trackId: number, value: number): Map<number, number> => {
  const known = tracks(header);
  const scale = known.get(trackId)?.timescale;
  if (!scale) return new Map();
  return new Map([...known].map(([other, track]) => [other, Math.floor(value * track.timescale / scale)]));
};

const videoTrack = (header: Uint8Array): number | undefined => [...tracks(header)].find(([, track]) => track.video)?.[0];

/** The picture's decode time in `fragment`, as that time in every track: a stream moved by it keeps its sound with its picture. */
export const videoTime = (header: Uint8Array, fragment: Uint8Array): Map<number, number> => {
  const video = videoTrack(header);
  const time = video === undefined ? undefined : decodeTimes(fragment).get(video);
  return video === undefined || time === undefined ? new Map() : sameTime(header, video, time);
};

/** The fragment with each track's decode time `base` gives it earlier, so a reader's stream starts at 0. */
export const rebased = (fragment: Uint8Array, base: Map<number, number>): Uint8Array =>
  atDecodeTimes(fragment, new Map([...decodeTimes(fragment)].map(([trackId, value]) => [trackId, value - (base.get(trackId) ?? 0)])));

/**
 * How long a fragment lasts in a track's timescale, the first track's unless `trackId`: its
 * samples' durations from its `trun`, or their count times its `tfhd`'s default, or the header's
 * `trex`'s; undefined when it says none.
 */
export const fragmentDuration = (fragment: Uint8Array, header: Uint8Array, trackId?: number): number | undefined => {
  const all = trafs(fragment);
  const found = all.find(([id]) => trackId === undefined || id === trackId);
  if (!found) return undefined;
  const [track, ...traf] = found;
  const tfhd = child(fragment, ...traf, 'tfhd');
  const trun = child(fragment, ...traf, 'trun');
  if (!tfhd || !trun) return undefined;
  let fallback: number | undefined;
  let flags = flagsOf(fragment, tfhd[0]);
  const at = tfhd[0] + 16 + (flags & 0x1 ? 8 : 0) + (flags & 0x2 ? 4 : 0);
  if (flags & 0x8) fallback = u32(fragment, at);
  else fallback = tracks(header).get(track)?.defaultDuration;
  flags = flagsOf(fragment, trun[0]);
  const count = u32(fragment, trun[0] + 12);
  if (!(flags & 0x100)) return fallback ? count * fallback : undefined;
  const first = trun[0] + 16 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
  const width = 4 * [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length;
  let total = 0;
  for (let n = 0; n < count; n++) total += u32(fragment, first + n * width);
  return total;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * What a reader is sent at once so that Chrome reads its metadata at once: the header and the
 * fragments since the keyframe (their clock at 0, as the caller gives them), the keyframe's fragment
 * repeated after itself until they hold `QUICK_START_SECONDS`, and a `free` box filling the bytes
 * out to Chrome's next read. Repeated straight after itself, the fragment leaves the decoder as it
 * found it, so the next one follows on. Also how much later, in each track, the fragments that
 * follow come: what was repeated, timed by the picture, so the sound stays with it.
 */
export const quickStart = (header: Uint8Array, fragments: Uint8Array[]): { start: Uint8Array[]; shift: Map<number, number> } => {
  const video = videoTrack(header);
  const lengths = video === undefined ? [] : fragments.map((fragment) => fragmentDuration(fragment, header, video));
  if (video === undefined || !fragments.length || lengths.some((length) => length === undefined) || !lengths[0]) {
    return { start: [header, ...fragments], shift: new Map() };
  }
  const scale = tracks(header).get(video)!.timescale;
  const first = lengths[0]!;
  const held = lengths.reduce((total: number, length) => total + length!, 0);
  const repeats = Math.max(0, Math.ceil((Math.floor(QUICK_START_SECONDS * scale) - held) / first));
  const starts = decodeTimes(fragments[0]);
  const later = (n: number) => sameTime(header, video, n * first);
  const moved = (fragment: Uint8Array, by: Map<number, number>, times: Map<number, number>) =>
    atDecodeTimes(fragment, new Map([...times].map(([trackId, value]) => [trackId, value + (by.get(trackId) ?? 0)])));
  const shift = later(repeats);
  const start = [header, fragments[0]];
  for (let n = 1; n <= repeats; n++) start.push(moved(fragments[0], later(n), starts));
  for (const fragment of fragments.slice(1)) start.push(moved(fragment, shift, decodeTimes(fragment)));
  let gap = (CHROME_READ - start.reduce((total, piece) => total + piece.length, 0) % CHROME_READ) % CHROME_READ;
  if (gap) {
    if (gap < 8) gap += CHROME_READ;
    const free = new Uint8Array(gap);
    view(free).setUint32(0, gap);
    free.set([0x66, 0x72, 0x65, 0x65], 4);
    start.push(free);
  }
  return { start, shift };
};

/**
 * The MP4 header (`ftyp` and `moov`) saying the stream lasts `seconds`: in `mvhd`, each track's
 * `tkhd` and `mdhd`, and an `mehd` in `mvex`. A live header says nothing (0), so a browser takes what
 * it has read for the duration, and Chrome offers a screen near it nothing of 15 s or less; one that
 * reads this one counts the stream that long.
 */
export const declared = (header: Uint8Array, seconds: number): Uint8Array => {
  const moov = top(header, 'moov');
  if (!moov) return header;
  const mvhd = child(header, ...moov, 'mvhd');
  const mvex = child(header, ...moov, 'mvex');
  if (!mvhd || !mvex) return header;
  const b = header.slice();
  const put = (box: number, value: number, track = false) => {
    // A full box's duration follows its version and flags, two times and a word: mvhd's and mdhd's
    // timescale, tkhd's track id, then for tkhd a reserved word too.
    const at = box + (b[box + 8] === 1 ? 32 : 24) + (track ? 4 : 0);
    if (b[box + 8] === 1) view(b).setBigUint64(at, BigInt(value));
    else view(b).setUint32(at, value);
  };
  const timescale = (box: number) => u32(b, box + (b[box + 8] === 1 ? 28 : 20));
  const scale = timescale(mvhd[0]);
  put(mvhd[0], seconds * scale);
  for (const [kind, at, size] of boxes(b, moov[0] + 8, moov[0] + moov[1])) {
    if (kind !== 'trak') continue;
    const tkhd = child(b, at, size, 'tkhd');
    if (tkhd) put(tkhd[0], seconds * scale, true);
    const mdia = child(b, at, size, 'mdia');
    const mdhd = mdia ? child(b, ...mdia, 'mdhd') : undefined;
    if (mdhd) put(mdhd[0], seconds * timescale(mdhd[0]));
  }
  if (child(b, ...mvex, 'mehd')) return b;
  const mehd = new Uint8Array(16);
  view(mehd).setUint32(0, 16);
  mehd.set([0x6d, 0x65, 0x68, 0x64], 4);
  view(mehd).setUint32(12, seconds * scale);
  const out = concat([b.subarray(0, mvex[0] + 8), mehd, b.subarray(mvex[0] + 8)]);
  view(out).setUint32(mvex[0], mvex[1] + 16);
  view(out).setUint32(moov[0], moov[1] + 16);
  return out;
};

/**
 * Fragmented MP4 fed as it comes, cut into its header (`ftyp` and `moov` together) and its
 * fragments (`moof` and `mdat` together), each a start when its first sample is a keyframe. Any
 * other box goes as it is.
 */
export class Mp4Splitter {
  #buffer: Uint8Array = new Uint8Array(0);
  #head: Uint8Array[] = [];
  #moof?: Uint8Array;

  /** Whether the header has come. */
  header?: Uint8Array;

  feed(data: Uint8Array): Piece[] {
    this.#buffer = this.#buffer.length ? concat([this.#buffer, data]) : data.slice();
    const out: Piece[] = [];
    let at = 0;
    while (this.#buffer.length - at >= 8) {
      const size = boxSize(this.#buffer, at);
      if (size === 0) break;
      if (size < 8) throw new Error(`an MP4 box of ${size} bytes`);
      if (this.#buffer.length - at < size) break;
      const box = this.#buffer.slice(at, at + size);
      const kind = ascii(box, 4);
      at += size;
      if (kind === 'ftyp' || kind === 'moov') {
        this.#head.push(box);
        if (kind === 'moov') {
          this.header = concat(this.#head);
          this.#head = [];
          out.push({ kind: 'header', bytes: this.header });
        }
      } else if (kind === 'moof') {
        this.#moof = box;
      } else if (kind === 'mdat' && this.#moof) {
        out.push({ kind: fragmentIsKey(this.#moof) ? 'start' : 'data', bytes: concat([this.#moof, box]) });
        this.#moof = undefined;
      } else {
        out.push({ kind: 'data', bytes: box });
      }
    }
    this.#buffer = this.#buffer.slice(at);
    return out;
  }
}
