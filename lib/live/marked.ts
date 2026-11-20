/**
 * A stream node's writer for what the media service writes into it: its bytes cut by the node's
 * media type, so the stream's header and its start points are marked as the stream registry keeps
 * them for a reader who joins later. Fragmented MP4 (`video/mp4`): `ftyp` and `moov` are the
 * header, and each fragment that starts at a keyframe a start point. MPEG-TS (`video/mp2t`): the
 * first PAT and PMT are the header, and each packet of the picture that marks a keyframe a start
 * point. Any other type is written as it comes.
 *
 * The bytes are written in order, each write following on from the last: a write anywhere else is
 * refused, since a stream cannot go back.
 */

import type { StreamWriter } from '@ein/client';
import type { NodeHandle } from '../files-sftp.ts';
import { splitterFor } from './split.ts';

/** `writer`, written as `mimetype`'s bytes. */
export const markedWriter = (writer: StreamWriter, mimetype: string | undefined): NodeHandle => {
  const splitter = splitterFor(mimetype);
  let written = 0;
  return {
    seek: (offset) => offset === written ? Promise.resolve(offset) : Promise.reject(new Deno.errors.PermissionDenied('a stream is written in order, from its start')),
    read: () => Promise.reject(new Deno.errors.PermissionDenied('a stream is written here, not read')),
    write: async (data) => {
      written += data.length;
      if (!splitter) return await writer.write(data);
      for (const piece of splitter.feed(data)) {
        if (piece.kind === 'header') await writer.writeHeader(piece.bytes);
        else if (piece.kind === 'start') await writer.writeStart(piece.bytes);
        else await writer.write(piece.bytes);
      }
      return data.length;
    },
    size: () => Promise.resolve(written),
    close: () => writer.close(),
  };
};
