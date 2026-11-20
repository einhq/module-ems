/**
 * A live stream's bytes cut where a reader may start in them, by their media type: fragmented MP4
 * (`video/mp4`) and MPEG-TS (`video/mp2t`), each into its header and its pieces, those that start
 * at a keyframe told apart. A writer of a stream node marks them as the stream registry keeps them
 * for a reader who joins later.
 */

import { Mp4Splitter } from './mp4.ts';
import type { Piece } from './piece.ts';
import { TsSplitter } from './ts.ts';

/** Cuts the bytes of one read of a stream, fed as they come. */
type Splitter = { feed(data: Uint8Array): Piece[] };

/** A splitter for a stream of `mimetype`'s bytes; undefined for a type it does not cut. */
export const splitterFor = (mimetype: string | undefined): Splitter | undefined => {
  if (mimetype === 'video/mp4') return new Mp4Splitter();
  if (mimetype === 'video/mp2t') return new TsSplitter();
  return undefined;
};
