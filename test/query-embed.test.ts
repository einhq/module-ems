/**
 * `embedQuery`: callers with the same query text share one `text.embed` request, a failed request
 * is not kept, and a caller waiting on a request whose command hung up asks again with its own.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { Command } from '@ein/client';
import { EmsError, EmsUnavailableError } from '../lib/client.ts';
import { embedQuery } from '../lib/text-embedding.ts';
import { startStubEms } from './stub-ems.ts';

const PRODUCER = 'jina-embeddings-v5-text-small';

/** Minimal Command: env, a VFS with no settings files, and an `interrupted` flag the test can flip. */
const makeCmd = (url: string) =>
  ({
    env: { CFG_EMS_URL: url },
    access: {},
    interrupted: false,
    sys: { vfs: { open: () => Promise.reject(new Error('no such node')), children: () => Promise.reject(new Error('no such node')) } },
  }) as unknown as Command & { interrupted: boolean };

const vectorOf = (bytes: Uint8Array): number[] => JSON.parse(new TextDecoder().decode(bytes));

Deno.test('the providers of one search share one embed of the query', async () => {
  const stub = startStubEms({ ops: { 'text.embed': { result: { embeddings: [[0.5, 0.5]], dimension: 2 }, producer: PRODUCER } }, delayMs: 50 });
  try {
    const [media, document] = await Promise.all([
      embedQuery(makeCmd(stub.url), 'en segelbåt'),
      embedQuery(makeCmd(stub.url), 'en segelbåt'),
    ]);
    assertEquals([media.type, document.type], ['text_jina5s', 'text_jina5s']);
    assertEquals(vectorOf(document.bytes), [0.5, 0.5]);
    // A caller after the answer arrived, as the next page's fan-out is, is answered from it too.
    await embedQuery(makeCmd(stub.url), 'en segelbåt');
    assertEquals(stub.requests.filter((request) => request.op === 'text.embed').length, 1);
    assertEquals(stub.requests[0].body.role, 'query');

    await embedQuery(makeCmd(stub.url), 'en ekorre');
    assertEquals(stub.requests.filter((request) => request.op === 'text.embed').length, 2);
  } finally {
    await stub.close();
  }
});

Deno.test('a failed embed is not kept: the next caller asks again', async () => {
  let calls = 0;
  const stub = startStubEms({
    ops: {
      'text.embed': () =>
        ++calls === 1
          ? { error: { code: 'invalid_request', message: 'no', permanent: true }, status: 400 }
          : { result: { embeddings: [[1, 0]], dimension: 2 }, producer: PRODUCER },
    },
  });
  try {
    await assertRejects(() => embedQuery(makeCmd(stub.url), 'en fyr'), EmsError);
    assertEquals(vectorOf((await embedQuery(makeCmd(stub.url), 'en fyr')).bytes), [1, 0]);
    assertEquals(calls, 2);
  } finally {
    await stub.close();
  }
});

Deno.test("a caller waiting on an interrupted command's embed asks again with its own", async () => {
  const stub = startStubEms({ ops: { 'text.embed': { result: { embeddings: [[0, 1]], dimension: 2 }, producer: PRODUCER } }, delayMs: 1500 });
  try {
    const owner = makeCmd(stub.url);
    const joiner = makeCmd(stub.url);
    const owned = embedQuery(owner, 'en bro');
    const joined = embedQuery(joiner, 'en bro');
    owner.interrupted = true;
    await assertRejects(() => owned, EmsUnavailableError, 'interrupted');
    assertEquals(vectorOf((await joined).bytes), [0, 1]);
    assertEquals(stub.hungUp, ['text.embed']);
    assertEquals(stub.requests.filter((request) => request.op === 'text.embed').length, 2);
  } finally {
    await stub.close();
  }
});
