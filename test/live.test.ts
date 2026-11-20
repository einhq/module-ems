/**
 * A live stream's MP4 and TS cut where a reader may start, and an MP4 reader's start: its clock
 * moved, its header saying it lasts a day, and a second of it at once filling out Chrome's read;
 * and a stream node written with its header and start points marked by its media type. The fixtures
 * are what the media service's page encode writes (two seconds of a picture at 15 fps with a
 * keyframe a second, and a tone as AAC, a fragment every 200 ms):
 *
 *     ffmpeg -f lavfi -i testsrc2=s=160x90:r=15 -f lavfi -i sine=f=440:r=48000 -t 2 \
 *       -c:v libx264 -preset ultrafast -bf 0 -g 15 -c:a aac -b:a 64k -ar 48000 -ac 2 \
 *       -map 0:v -map 1:a -flags +global_header -f tee \
 *       "[f=mp4:movflags=frag_keyframe+empty_moov+default_base_moof:frag_duration=200000]page.mp4|[f=mpegts:bsfs/v=dump_extra=freq=keyframe]page.mpegts"
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { StreamWriter } from '@ein/client';
import { markedWriter } from '../lib/live/marked.ts';
import { atDecodeTimes, declared, decodeTimes, fragmentDuration, Mp4Splitter, quickStart, rebased, tracks, videoTime } from '../lib/live/mp4.ts';
import type { Piece } from '../lib/live/piece.ts';
import { TS_PACKET, TsSplitter } from '../lib/live/ts.ts';

const MP4 = Deno.readFileSync(new URL('./data/page.mp4', import.meta.url));
const TS = Deno.readFileSync(new URL('./data/page.mpegts', import.meta.url));

const ascii = (data: Uint8Array, at: number) => new TextDecoder().decode(data.subarray(at, at + 4));

const join = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const fed = (splitter: { feed(data: Uint8Array): Piece[] }, data: Uint8Array, step = 1000): Piece[] => {
  const pieces: Piece[] = [];
  for (let at = 0; at < data.length; at += step) pieces.push(...splitter.feed(data.subarray(at, at + step)));
  return pieces;
};

/** The fixture's declared header and its fragments, their clock starting at 0, as a screen near a browser is sent them. */
const stream = (): { header: Uint8Array; fragments: Uint8Array[] } => {
  const splitter = new Mp4Splitter();
  const fragments = splitter.feed(MP4).filter((piece) => ascii(piece.bytes, 4) === 'moof').map((piece) => piece.bytes);
  const base = videoTime(splitter.header!, fragments[0]);
  return { header: declared(splitter.header!, 86400), fragments: fragments.map((fragment) => rebased(fragment, base)) };
};

const second = (header: Uint8Array) => tracks(header).get(1)!.timescale;

Deno.test('the MP4 is cut into its header and fragments, a start at each keyframe', () => {
  const splitter = new Mp4Splitter();
  const pieces = fed(splitter, MP4);
  assertEquals(pieces[0].kind, 'header');
  assertEquals(ascii(pieces[0].bytes, 4), 'ftyp');
  // The index ffmpeg writes as it closes, which a live stream never reaches, goes as it is.
  assertEquals(ascii(pieces.at(-1)!.bytes, 4), 'mfra');
  const fragments = pieces.slice(1, -1);
  assert(fragments.every((piece) => ascii(piece.bytes, 4) === 'moof'));
  assertEquals(fragments.filter((piece) => piece.kind === 'start').length, 2);
  assertEquals(fragments[0].kind, 'start');
  // Every fragment holds the picture and the sound.
  assert(fragments.every((piece) => decodeTimes(piece.bytes).size === 2));
  assertEquals(join(pieces.map((piece) => piece.bytes)), MP4);
});

Deno.test('the header names the picture and the sound by their timescales', () => {
  const splitter = new Mp4Splitter();
  splitter.feed(MP4);
  const found = tracks(splitter.header!);
  assertEquals([...found.values()].map((track) => track.video), [true, false]);
  assertEquals(found.get(2)!.timescale, 48000);
});

Deno.test("the TS is cut at its keyframes, its first tables its header, with the picture's time at each start", () => {
  const splitter = new TsSplitter();
  const pieces = fed(splitter, TS);
  assertEquals(pieces.filter((piece) => piece.kind === 'header').length, 1);
  assertEquals(splitter.header!.length, 2 * TS_PACKET);
  // Nothing is lost or added: the header's packets go once, as the header.
  assertEquals(join(pieces.map((piece) => piece.bytes)), TS);
  const starts = pieces.filter((piece) => piece.kind === 'start');
  // The picture's two keyframes, not the sound's packets, which ffmpeg marks too.
  assertEquals(starts.length, 2);
  assert(starts.every((piece) => piece.bytes[0] === 0x47 && piece.bytes[5] & 0x40));
  assert(starts.every((piece) => piece.pts !== undefined));
  // A keyframe a second, at 90 kHz.
  assertEquals(starts[1].pts! - starts[0].pts!, 90_000);
});

Deno.test('a declared header gains an mehd once', () => {
  const splitter = new Mp4Splitter();
  splitter.feed(MP4);
  const header = declared(splitter.header!, 86400);
  assertEquals(header.length, splitter.header!.length + 16);
  assertEquals(new TextDecoder('latin1').decode(header).split('mehd').length - 1, 1);
  assertEquals(declared(header, 86400), header);
});

Deno.test('every track is moved by the same time', () => {
  const { header, fragments } = stream();
  const [video, audio] = [tracks(header).get(1)!, tracks(header).get(2)!];
  const base = videoTime(header, fragments[3]);
  assertEquals(base.get(1)! / video.timescale, base.get(2)! / audio.timescale);
  const moved = rebased(fragments[3], base);
  assertEquals(decodeTimes(moved).get(1), 0);
  // The sound keeps where it was against the picture, to within one of its samples.
  const was = decodeTimes(fragments[3]);
  assert(Math.abs((was.get(2)! - decodeTimes(moved).get(2)!) / audio.timescale - was.get(1)! / video.timescale) <= 1 / audio.timescale);
});

Deno.test("a quick start holds a second and fills out Chrome's read", () => {
  const { header, fragments } = stream();
  const { start, shift } = quickStart(header, fragments.slice(0, 1));
  const first = fragmentDuration(fragments[0], header, 1)!;
  const repeated = start.filter((piece) => ascii(piece, 4) === 'moof');
  assertEquals(start[0], header);
  assertEquals(ascii(start.at(-1)!, 4), 'free');
  assertEquals(start.reduce((total, piece) => total + piece.length, 0) % (32 * 1024), 0);
  // The keyframe's fragment again and again straight after itself, a second of it in all.
  for (const piece of repeated) assertEquals(atDecodeTimes(piece, decodeTimes(fragments[0])), fragments[0]);
  assertEquals(repeated.map((piece) => decodeTimes(piece).get(1)), repeated.map((_, n) => n * first));
  assert(repeated.length * first >= second(header) && second(header) > (repeated.length - 1) * first);
  assertEquals(shift.get(1), (repeated.length - 1) * first);
  // The sound is repeated with it, as long after as the picture.
  assertEquals(shift.get(2), Math.floor(shift.get(1)! * tracks(header).get(2)!.timescale / tracks(header).get(1)!.timescale));
});

Deno.test('a quick start leaves what already holds a second as it is', () => {
  const { header, fragments } = stream();
  const held = fragments.filter((_, n) => fragments.slice(0, n).reduce((total, each) => total + fragmentDuration(each, header, 1)!, 0) < second(header));
  const { start, shift } = quickStart(header, held);
  assertEquals(new Set(shift.values()), new Set([0]));
  assertEquals(start.slice(1, 1 + held.length), held);
});

/** A stream's writer that records what it was given, and how. */
const recorder = () => {
  const calls: [string, number][] = [];
  const writer = {
    wanted: true,
    onWanted: () => () => {},
    write: (data: Uint8Array) => (calls.push(['write', data.length]), Promise.resolve(data.length)),
    writeHeader: (data: Uint8Array) => (calls.push(['header', data.length]), Promise.resolve(data.length)),
    writeStart: (data: Uint8Array) => (calls.push(['start', data.length]), Promise.resolve(data.length)),
    close: () => (calls.push(['close', 0]), Promise.resolve()),
  } as unknown as StreamWriter;
  return { calls, writer };
};

Deno.test('a stream node written as MP4 has its header and keyframes marked; one written elsewhere than on is refused', async () => {
  const { calls, writer } = recorder();
  const handle = markedWriter(writer, 'video/mp4');
  for (let at = 0; at < MP4.length; at += 4096) assertEquals(await handle.write(MP4.subarray(at, at + 4096)), Math.min(4096, MP4.length - at));
  assertEquals(calls.filter(([how]) => how === 'header').length, 1);
  assertEquals(calls[0][0], 'header');
  assertEquals(calls.filter(([how]) => how === 'start').length, 2);
  assertEquals(await handle.size(), MP4.length);
  assertEquals(await handle.seek(MP4.length, 0), MP4.length);
  await assertRejects(() => handle.seek(0, 0), Deno.errors.PermissionDenied);
  await handle.close();
  assertEquals(calls.at(-1), ['close', 0]);
});

Deno.test('a stream node written as TS has its tables and keyframes marked, and any other type is written as it comes', async () => {
  const ts = recorder();
  await markedWriter(ts.writer, 'video/mp2t').write(TS);
  assertEquals(ts.calls.map(([how]) => how).filter((how) => how !== 'write'), ['header', 'start', 'start']);
  const other = recorder();
  await markedWriter(other.writer, 'application/octet-stream').write(TS);
  assertEquals(other.calls, [['write', TS.length]]);
});
