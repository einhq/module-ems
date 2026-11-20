/**
 * A piece of a live stream, cut where a reader may start in it: its header, a piece that starts at
 * a keyframe (with the picture's presentation time there, in 90 kHz ticks, when the format says
 * it), or any other.
 */
export type Piece = { kind: 'header' | 'start' | 'data'; bytes: Uint8Array; pts?: number };
