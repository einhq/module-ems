/**
 * A stream name's window: a read answers what has come at its offset, short when only some has; a
 * read ahead waits for its bytes; a read for bytes let go, too far ahead, past the end, or waiting
 * too long is the end.
 */

import { assertEquals } from '@std/assert';
import { StreamWindow } from '../lib/files-stream.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

Deno.test('a read answers what has come at its offset, across chunks, short when only some has', async () => {
  const window = new StreamWindow();
  window.push(bytes('abc'));
  window.push(bytes('defg'));
  assertEquals(text(await window.read(1, 4)), 'bcde');
  assertEquals(text(await window.read(5, 100)), 'fg');
});

Deno.test('reads ahead wait for their bytes, each answered as its own come', async () => {
  const window = new StreamWindow();
  const later = window.read(4, 2);
  const next = window.read(0, 4);
  window.push(bytes('abcd'));
  assertEquals(text(await next), 'abcd');
  window.push(bytes('ef'));
  assertEquals(text(await later), 'ef');
});

Deno.test('bytes let go, a read too far ahead, the end and a long wait are each the end', async () => {
  const window = new StreamWindow({ window: 4, stallMs: 20 });
  window.push(bytes('abcd'));
  window.push(bytes('efgh'));
  assertEquals(await window.read(0, 2), null);
  assertEquals(text(await window.read(4, 2)), 'ef');
  assertEquals(await window.read(20, 2), null);
  assertEquals(await window.read(8, 2), null);
  const waiting = window.read(8, 2);
  window.finish();
  assertEquals(await waiting, null);
  assertEquals(text(await window.read(6, 10)), 'gh');
});
