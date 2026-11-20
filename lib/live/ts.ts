/**
 * MPEG-TS as a live stream carries it, cut into pieces of whole packets: its header, the first
 * programme tables (the PAT and the PMT it names, which says which packets are the picture's), and
 * a piece starting at each packet of the picture that marks a keyframe (`random_access_indicator`;
 * ffmpeg marks every packet of sound too), with the picture's presentation time there. The tables
 * that come again later go as any other packet.
 */

import type { Piece } from './piece.ts';

export const TS_PACKET = 188;

/** The PMT's stream types of a picture: MPEG-2, H.264, HEVC. */
const VIDEO_STREAM_TYPES = new Set([0x02, 0x1b, 0x24]);

/** Where a packet's payload starts, past its adaptation field. */
const payloadAt = (packet: Uint8Array): number => 4 + ((packet[3] >> 4) & 0x2 ? 1 + packet[4] : 0);

/** The section a PSI packet starts, past its pointer field, and where it ends without its CRC. */
const section = (packet: Uint8Array): [number, number] => {
  let at = payloadAt(packet);
  at += 1 + packet[at];
  const length = ((packet[at + 1] & 0x0f) << 8) | packet[at + 2];
  return [at, Math.min(at + 3 + length - 4, TS_PACKET)];
};

const pmtPid = (packet: Uint8Array): number | undefined => {
  const [at, end] = section(packet);
  for (let entry = at + 8; entry < end - 3; entry += 4) {
    const program = (packet[entry] << 8) | packet[entry + 1];
    if (program !== 0) return ((packet[entry + 2] & 0x1f) << 8) | packet[entry + 3];
  }
  return undefined;
};

/** The PID of the first picture the PMT in `packet` lists. */
const videoPid = (packet: Uint8Array): number | undefined => {
  const [at, end] = section(packet);
  let entry = at + 12 + (((packet[at + 10] & 0x0f) << 8) | packet[at + 11]);
  while (entry + 5 <= end) {
    if (VIDEO_STREAM_TYPES.has(packet[entry])) return ((packet[entry + 1] & 0x1f) << 8) | packet[entry + 2];
    entry += 5 + (((packet[entry + 3] & 0x0f) << 8) | packet[entry + 4]);
  }
  return undefined;
};

/** The presentation time of the PES a packet starts, in 90 kHz ticks; undefined when it starts none or says none. */
const ptsOf = (packet: Uint8Array): number | undefined => {
  if (!(packet[1] & 0x40)) return undefined;
  const at = payloadAt(packet);
  if (at + 14 > TS_PACKET || packet[at] !== 0 || packet[at + 1] !== 0 || packet[at + 2] !== 1 || !(packet[at + 7] & 0x80)) return undefined;
  const p = packet.subarray(at + 9, at + 14);
  return ((p[0] >> 1) & 0x07) * 2 ** 30 + p[1] * 2 ** 22 + (p[2] >> 1) * 2 ** 15 + p[3] * 2 ** 7 + (p[4] >> 1);
};

export class TsSplitter {
  #buffer: Uint8Array = new Uint8Array(0);
  #pmtPid?: number;
  #pat?: Uint8Array;
  #videoPid?: number;
  /** The first programme tables, once both have come. */
  header?: Uint8Array;

  feed(data: Uint8Array): Piece[] {
    const buffer = new Uint8Array(this.#buffer.length + data.length);
    buffer.set(this.#buffer);
    buffer.set(data, this.#buffer.length);
    const out: Piece[] = [];
    let piece: Uint8Array[] = [];
    let start: { pts?: number } | undefined;
    const close = () => {
      if (!piece.length) return;
      const bytes = new Uint8Array(piece.length * TS_PACKET);
      piece.forEach((packet, n) => bytes.set(packet, n * TS_PACKET));
      out.push(start ? { kind: 'start', bytes, ...(start.pts === undefined ? {} : { pts: start.pts }) } : { kind: 'data', bytes });
      piece = [];
      start = undefined;
    };
    let at = 0;
    while (buffer.length - at >= TS_PACKET) {
      if (buffer[at] !== 0x47) {
        const next = buffer.indexOf(0x47, at + 1);
        at = next > 0 ? next : buffer.length;
        continue;
      }
      const packet = buffer.slice(at, at + TS_PACKET);
      at += TS_PACKET;
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      const adaptation = (packet[3] >> 4) & 0x3;
      if (pid === 0 && packet[1] & 0x40) {
        this.#pmtPid = pmtPid(packet);
        if (!this.header) {
          this.#pat = packet;
          continue;
        }
      } else if (pid === this.#pmtPid && packet[1] & 0x40) {
        this.#videoPid = videoPid(packet);
        if (!this.header && this.#pat) {
          close();
          this.header = new Uint8Array([...this.#pat, ...packet]);
          out.push({ kind: 'header', bytes: this.header });
          continue;
        }
      }
      if (pid === this.#videoPid && adaptation & 0x2 && packet[4] > 0 && packet[5] & 0x40) {
        close();
        start = { pts: ptsOf(packet) };
      }
      piece.push(packet);
    }
    close();
    this.#buffer = buffer.slice(at);
    return out;
  }
}
