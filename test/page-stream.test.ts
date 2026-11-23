/**
 * `page-stream`, against a stand-in EMS: the page put with an address that signs the media
 * service's browser in once as the caller and opens the page, and two stream nodes of the caller's
 * granted to the media service for writing, which a screen reads with a file ticket from the
 * latest keyframe; the MP4 for a screen near a browser and the live HLS made from them; listed for
 * its owner, keys pressed in its page for its owner alone, and gone, nodes and all, once stopped,
 * once EMS no longer has it or once nobody has read it for its idle seconds.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import { ADMIN_ACCESS, isStreamWriter } from '@ein/client';
import { createTestContext, testCommands } from '@ein/testing';
import { markedWriter } from '../lib/live/marked.ts';
import { TsSplitter } from '../lib/live/ts.ts';
import { pageOrigin, type PageStream } from '@ems/page-stream';
import { startStubEms } from './stub-ems.ts';

const testCtx = createTestContext({ modules: ['ems'], boot: true });

const MP4 = Deno.readFileSync(new URL('./data/page.mp4', import.meta.url));
const TS = Deno.readFileSync(new URL('./data/page.mpegts', import.meta.url));

/** The fixture's programme tables, a stream's header. */
const TABLES = (() => {
  const splitter = new TsSplitter();
  splitter.feed(TS);
  return splitter.header!;
})();

/** Where the fixture's second keyframe starts. */
const secondKey = (): number => {
  let at = 0;
  let starts = 0;
  for (const piece of new TsSplitter().feed(TS)) {
    if (piece.kind === 'start' && ++starts === 2) return at;
    at += piece.bytes.length;
  }
  throw new Error('the fixture has no second keyframe');
};

const settled = async (done: () => Promise<boolean>, what: string): Promise<void> => {
  for (let tries = 0; tries < 300; tries++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never: ${what}`);
};

Deno.test("the media service reaches pages at their own address, else at the files host on EiN's port", () => {
  assertEquals(pageOrigin({ CFG_EMS_PAGE_ADDRESS: 'ein.lan:8090', CFG_EMS_FILES_ADDRESS: 'core:2224' }), 'http://ein.lan:8090');
  assertEquals(pageOrigin({ CFG_EMS_FILES_ADDRESS: 'host.containers.internal:2224', CFG_HTTP_PORT: '8080' }), 'http://host.containers.internal:8080');
  assertEquals(pageOrigin({ CFG_EMS_FILES_ADDRESS: 'core:2224' }), 'http://core:8080');
});

Deno.test({ name: 'page-stream', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const admin = await testCtx.server.createShellClient();
  const ems = startStubEms();
  await admin.execString(`config set CFG_EMS_URL ${ems.url} && config set CFG_EMS_FILES_ADDRESS ein.test:2224`);
  await admin.execString('user-create anna && user-passwd anna --new-password hunter2');
  const client = await testCtx.server.createShellClient({ username: 'anna', password: 'hunter2' });
  /** What a shell may set in front of a command, which a page's address never goes by. */
  const at = 'CFG_EMS_URL=http://127.0.0.1:9 CFG_EMS_PAGE_ADDRESS=elsewhere.test:80 CFG_HTTP_PORT=81';
  const { baseUrl, devices } = testCtx.harness.instance!;
  /** The media service's writer of a page's stream node, as `ems-files` gives it one. */
  const writerOf = async (path: string, mimetype: string) => {
    const handle = await vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
    assert(isStreamWriter(handle));
    return markedWriter(handle, mimetype);
  };
  const readers = async (path: string) => ((await vfs.stat(ADMIN_ACCESS, path)) as { readers?: number }).readers ?? 0;

  try {
    let stream: PageStream;

    await t.step("start puts the page with an address that signs its browser in, and its stream nodes to write, by the system's settings", async () => {
      stream = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Kitchen --fps=25`);
      assertEquals(stream.route, '/dashboard-wall/Kitchen');
      assertEquals(stream.path, `/tmp/page-streams/${stream.id}`);
      const put = ems.requests.find((request) => request.op === 'pages.put')!;
      assertEquals(put.body.video, { fps: 25 });
      assertEquals('idle' in put.body, false);
      const url = String(put.body.url);
      assertMatch(url, /^http:\/\/ein\.test:8080\/__page\/[0-9a-f]{64}$/);
      // The media service is given names, which stand for the stream nodes.
      const output = put.body.output as Record<string, { path: string }>;
      assertMatch(output.mp4.path, /^\/[0-9a-f]{32}\/\d-page-[0-9a-f]{16}\.mp4$/);
      assertEquals(ems.pageNodes.get(stream.id), { mp4: `${stream.path}.mp4`, ts: `${stream.path}.ts` });
      const node = await vfs.get(ADMIN_ACCESS, `${stream.path}.ts`);
      assertEquals([node.type, node.attrs.mimetype, node.props.mode & 0o777], ['stream', 'video/mp2t', 0o600]);

      const signIn = await fetch(`${baseUrl}${new URL(url).pathname}`, { redirect: 'manual' });
      await signIn.body?.cancel();
      assertEquals(signIn.status, 303);
      assertEquals(signIn.headers.get('location'), '/dashboard-wall/Kitchen');
    });

    await t.step("the media service's browser goes where the system's settings say, whatever the caller's say", async () => {
      const other = await client.execJson<PageStream>(`${at} CFG_EMS_PAGE_ADDRESS=10.99.0.5:80 CFG_EMS_FILES_ADDRESS=10.99.0.5:2224 page-stream start /dashboard-wall/Hall`);
      const put = ems.requests.findLast((request) => request.op === 'pages.put')!;
      assertMatch(String(put.body.url), /^http:\/\/ein\.test:8080\/__page\//);
      await client.execJson(`${at} page-stream stop ${other.id}`);
    });

    await t.step('a screen reads a node with a file ticket, from its latest keyframe', async () => {
      const ts = await writerOf(`${stream.path}.ts`, 'video/mp2t');
      const second = secondKey();
      await ts.write(TS.subarray(0, second));
      const { uid } = (await client.execJson<{ attrs: { uid: number } }>('stat /etc/users/anna')).attrs;
      const ticket = await devices.fileTicket({ ...ADMIN_ACCESS, uid }, `${stream.path}.ts`);
      const read = await fetch(`${baseUrl}/file${stream.path}.ts?ticket=${ticket}`);
      assertEquals(read.headers.get('content-type'), 'video/mp2t');
      const reader = read.body!.getReader();
      const first = await reader.read();
      // The tables first, then the keyframe it joined at.
      assertEquals(first.value!.subarray(0, TABLES.length), TABLES);
      await reader.cancel();
      devices.dropFileTicket(ticket);

      // The live HLS waits for its first segment, from one keyframe to the next.
      await settled(async () => (await readers(`${stream.path}.ts`)) === 0, 'the screen has let go');
      const playlist = fetch(`${baseUrl}${stream.hls}`);
      await settled(async () => (await readers(`${stream.path}.ts`)) > 0, 'the HLS reads the node');
      await ts.write(TS.subarray(second));
      const listed = await playlist;
      assertEquals(listed.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      assertEquals(listed.headers.get('access-control-allow-origin'), '*');
      const text = await listed.text();
      assertStringIncludes(text, '#EXTINF:1.000,\nindex0.ts');
      const segment = new Uint8Array(await (await fetch(`${baseUrl}${stream.hls.replace('index.m3u8', 'index0.ts')}`)).arrayBuffer());
      assertEquals(segment.subarray(0, TABLES.length), TABLES);
      const missing = await fetch(`${baseUrl}${stream.hls.replace('index.m3u8', 'index9.ts')}`);
      await missing.body?.cancel();
      assertEquals(missing.status, 404);
      await ts.close();
    });

    await t.step('the MP4 for a screen near a browser says it lasts a day and holds a second at once', async () => {
      const mp4 = await writerOf(`${stream.path}.mp4`, 'video/mp4');
      await mp4.write(MP4);
      assertMatch(stream.remote, /^\/live\/[0-9a-f]{64}\/screen\.mp4$/);
      const remote = await fetch(`${baseUrl}${stream.remote}`);
      assertEquals(remote.headers.get('content-type'), 'video/mp4');
      const reader = remote.body!.getReader();
      let held = new Uint8Array(0);
      /** Where the start ends: past its `free` box, which fills it out to Chrome's next read. */
      const startEnds = (): number | undefined => {
        const view = new DataView(held.buffer);
        for (let at = 0; at + 8 <= held.length; at += view.getUint32(at)) {
          if (new TextDecoder().decode(held.subarray(at + 4, at + 8)) === 'free') return at + view.getUint32(at);
        }
        return undefined;
      };
      while (startEnds() === undefined) {
        const { value } = await reader.read();
        held = new Uint8Array([...held, ...value!]);
      }
      await reader.cancel();
      assertEquals(new TextDecoder().decode(held.subarray(4, 8)), 'ftyp');
      assertStringIncludes(new TextDecoder('latin1').decode(held), 'mehd');
      assertEquals(startEnds()! % (32 * 1024), 0);
      await mp4.close();
    });

    await t.step("press, state and message reach the caller's page, and no other", async () => {
      await client.execJson(`${at} page-stream press ${stream.id} ArrowRight Space`);
      const pressed = ems.requests.filter((request) => request.op === 'pages.keys');
      assertEquals(pressed.map((request) => request.body), [{ id: stream.id, keys: ['ArrowRight', 'Space'] }]);
      await testCommands(client).shouldFailWith(`${at} page-stream press page-0000000000000000 ArrowRight`, 'no such page stream');
      await testCommands(client).shouldFailWith(`${at} page-stream press ${stream.id}`, 'needs a stream');
      assertEquals(await client.execJson(`${at} page-stream state ${stream.id}`), { title: `shown by ${stream.id}`, position: '1 of 2' });
      assertEquals(await client.execJson(`${at} page-stream message ${stream.id} '{"seek":80}'`), { ok: true, taken: true });
      const told = ems.requests.filter((request) => request.op === 'pages.message');
      assertEquals(told.map((request) => request.body), [{ id: stream.id, message: { seek: 80 } }]);
      await testCommands(client).shouldFailWith(`${at} page-stream message ${stream.id} 80`, 'JSON object');
      await testCommands(client).shouldFailWith(`${at} page-stream state page-0000000000000000`, 'no such page stream');
    });

    await t.step('list shows it as EMS has it, and stop ends it there and here', async () => {
      const listed = await client.execJson<(PageStream & { state?: string; readers: number })[]>(`${at} page-stream list`);
      // Nobody reads its nodes, whose writers have closed.
      assertEquals(listed.map((each) => [each.id, each.state, each.readers]), [[stream.id, 'running', 0]]);

      await client.execJson(`${at} page-stream stop ${stream.id}`);
      assertEquals(ems.pages.size, 0);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${stream.path}.mp4`), false);
      const goneHls = await fetch(`${baseUrl}${stream.hls}`);
      await goneHls.body?.cancel();
      assertEquals(goneHls.status, 404);
      assertEquals(await client.execJson(`${at} page-stream list`), []);
    });

    await t.step('a page EMS no longer has is no longer served or listed', async () => {
      const second = await client.execJson<PageStream>(`${at} page-stream start /albums/Summer?slideshow=screen`);
      ems.pages.delete(second.id);
      assertEquals(await client.execJson(`${at} page-stream list`), []);
      assertEquals(await vfs.exists(ADMIN_ACCESS, `${second.path}.ts`), false);
      const ended = await fetch(`${baseUrl}${second.remote}`);
      await ended.body?.cancel();
      assertEquals(ended.status, 404);
    });

    await t.step("when EMS is full, the caller's streams nobody reads make room, and others' never", async () => {
      ems.pageLimit = 2;
      const read = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Kitchen`);
      const left = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Hall`);
      const reading = await vfs.open(ADMIN_ACCESS, `${read.path}.ts`, { mode: 'r' });
      const replacing = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Porch`);
      assertEquals([...ems.pages.keys()].sort(), [read.id, replacing.id].sort());
      const gone = await fetch(`${baseUrl}${left.hls}`);
      await gone.body?.cancel();
      assertEquals(gone.status, 404);

      const alsoReading = await vfs.open(ADMIN_ACCESS, `${replacing.path}.mp4`, { mode: 'r' });
      await testCommands(client).shouldFailWith(`${at} page-stream start /dashboard-wall/Attic`, 'someone watches each');
      await reading.close();
      await alsoReading.close();
      for (const id of [read.id, replacing.id]) await client.execJson(`${at} page-stream stop ${id}`);
      ems.pageLimit = Infinity;
    });

    await t.step('a page nobody reads for its idle seconds stops, nodes and all', async () => {
      const idle = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Kitchen --idle=1`);
      await settled(async () => !ems.pages.has(idle.id) && !(await vfs.exists(ADMIN_ACCESS, `${idle.path}.mp4`)), 'the idle page stops');
    });

    await t.step('a page is a path of this EiN', async () => {
      await testCommands(client).shouldFailWith(`${at} page-stream start https://elsewhere.test/`, 'a path of this server');
      await testCommands(client).shouldFailWith(`${at} page-stream start '/\\elsewhere.test/x'`, 'a path of this server');
    });

    await t.step('a page is never streamed as the administrator', async () => {
      const before = ems.requests.filter((request) => request.op === 'pages.put').length;
      await testCommands(admin).shouldFailWith('page-stream start /dashboard-wall/Kitchen', 'never shown as the administrator');
      assertEquals(ems.requests.filter((request) => request.op === 'pages.put').length, before);
      assertEquals(ems.pages.size, 0);
    });
  } finally {
    await ems.close();
    client.close();
    admin.close();
    await testCtx.teardown();
  }
});
