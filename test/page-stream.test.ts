/**
 * `page-stream`, against a stand-in EMS: the page put with an address that signs the media
 * service's browser in once as the caller and opens the page, the stream served at its `/live/`
 * path in both forms and as HLS at another, listed for its owner, and gone from there once stopped or once EMS no longer
 * has it.
 */

import { assertEquals, assertMatch } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import { pageOrigin, type PageStream } from '@ems/page-stream';
import { startStubEms } from './stub-ems.ts';

const testCtx = createTestContext({ modules: ['ems'], boot: true });

Deno.test("the media service reaches pages at their own address, else at the files host on EiN's port", () => {
  assertEquals(pageOrigin({ CFG_EMS_PAGE_ADDRESS: 'ein.lan:8090', CFG_EMS_FILES_ADDRESS: 'core:2224' }), 'http://ein.lan:8090');
  assertEquals(pageOrigin({ CFG_EMS_FILES_ADDRESS: 'host.containers.internal:2224', CFG_HTTP_PORT: '8080' }), 'http://host.containers.internal:8080');
  assertEquals(pageOrigin({ CFG_EMS_FILES_ADDRESS: 'core:2224' }), 'http://core:8080');
});

Deno.test({ name: 'page-stream', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const ems = startStubEms();
  const at = `CFG_EMS_URL=${ems.url} CFG_EMS_FILES_ADDRESS=ein.test:2224 CFG_HTTP_PORT=8080`;
  const { baseUrl } = testCtx.harness.instance!;

  try {
    let stream: PageStream;

    await t.step('start puts the page with an address that signs its browser in, and serves its stream', async () => {
      stream = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Kitchen --fps=25 --idle=60`);
      assertEquals(stream.route, '/dashboard-wall/Kitchen');
      const put = ems.requests.find((request) => request.op === 'pages.put')!;
      assertEquals(put.body.video, { fps: 25 });
      assertEquals(put.body.idle, 60);
      const url = String(put.body.url);
      assertMatch(url, /^http:\/\/ein\.test:8080\/__page\/[0-9a-f]{64}$/);

      const signIn = await fetch(`${baseUrl}${new URL(url).pathname}`, { redirect: 'manual' });
      await signIn.body?.cancel();
      assertEquals(signIn.status, 303);
      assertEquals(signIn.headers.get('location'), '/dashboard-wall/Kitchen');

      const mp4 = await fetch(`${baseUrl}${stream.path}.mp4`);
      assertEquals(mp4.headers.get('content-type'), 'video/mp4');
      assertEquals(await mp4.text(), `mp4 of ${stream.id}`);
      const ts = await fetch(`${baseUrl}${stream.path}.ts`);
      assertEquals(await ts.text(), `ts of ${stream.id}`);

      assertEquals(stream.remote, stream.hls.replace('index.m3u8', 'screen.mp4'));
      const remote = await fetch(`${baseUrl}${stream.remote}`);
      assertEquals(remote.headers.get('content-type'), 'video/mp4');
      assertEquals(await remote.text(), `mp4 of ${stream.id} lasting 86400 s`);

      assertMatch(stream.hls, /^\/live\/[0-9a-f]{64}\/index\.m3u8$/);
      const playlist = await fetch(`${baseUrl}${stream.hls}`);
      assertEquals(playlist.headers.get('content-type'), 'application/vnd.apple.mpegurl');
      assertEquals(playlist.headers.get('access-control-allow-origin'), '*');
      assertEquals(await playlist.text(), `index.m3u8 of ${stream.id}`);
      const segment = await fetch(`${baseUrl}${stream.hls.replace('index.m3u8', 'index3.ts')}`);
      assertEquals(await segment.text(), `index3.ts of ${stream.id}`);
    });

    await t.step('list shows it as EMS has it, and stop ends it there and here', async () => {
      const listed = await client.execJson<(PageStream & { state?: string })[]>(`${at} page-stream list`);
      assertEquals(listed.map((each) => [each.id, each.state]), [[stream.id, 'running']]);

      await client.execJson(`${at} page-stream stop ${stream.id}`);
      assertEquals(ems.pages.size, 0);
      const gone = await fetch(`${baseUrl}${stream.path}.mp4`);
      await gone.body?.cancel();
      assertEquals(gone.status, 404);
      const goneHls = await fetch(`${baseUrl}${stream.hls}`);
      await goneHls.body?.cancel();
      assertEquals(goneHls.status, 404);
      assertEquals(await client.execJson(`${at} page-stream list`), []);
    });

    await t.step('a page EMS no longer has is no longer served or listed', async () => {
      const second = await client.execJson<PageStream>(`${at} page-stream start /albums/Summer?slideshow=screen`);
      ems.pages.delete(second.id);
      const ended = await fetch(`${baseUrl}${second.path}.ts`);
      await ended.body?.cancel();
      assertEquals(ended.status, 404);
      assertEquals(await client.execJson(`${at} page-stream list`), []);
    });

    await t.step("when EMS is full, the caller's streams nobody reads make room, and others' never", async () => {
      ems.pageLimit = 2;
      const read = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Kitchen`);
      const left = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Hall`);
      ems.pagesRead.add(read.id);
      const replacing = await client.execJson<PageStream>(`${at} page-stream start /dashboard-wall/Porch`);
      assertEquals([...ems.pages.keys()].sort(), [read.id, replacing.id].sort());
      const gone = await fetch(`${baseUrl}${left.hls}`);
      await gone.body?.cancel();
      assertEquals(gone.status, 404);

      ems.pagesRead.add(replacing.id);
      await testCommands(client).shouldFailWith(`${at} page-stream start /dashboard-wall/Attic`, 'someone watches each');
      for (const id of [read.id, replacing.id]) await client.execJson(`${at} page-stream stop ${id}`);
      ems.pageLimit = Infinity;
    });

    await t.step('a page is a path of this EiN', async () => {
      await testCommands(client).shouldFailWith(`${at} page-stream start https://elsewhere.test/`, 'a path of this server');
    });
  } finally {
    await ems.close();
    client.close();
    await testCtx.teardown();
  }
});
