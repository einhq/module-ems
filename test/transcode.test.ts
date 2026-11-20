/**
 * `stream-transcode`, against a stand-in EMS: a stream node read and another written, made as the
 * caller's where there is none, granted to the media service by names, as MPEG-TS or, into an MP4
 * node, fragmented MP4; without an output, one made for it, the caller's alone and gone when it
 * stops; listed for its owner, refused for a source that is no stream, and stopped, its names
 * ended, once stopped or once nobody has read its output for its idle seconds.
 */

import { assert, assertEquals, assertMatch } from '@std/assert';
import { ADMIN_ACCESS } from '@ein/client';
import { createTestContext, testCommands } from '@ein/testing';
import type { TranscodeStream } from '@ems/api';
import { filesState } from '../lib/files.ts';
import { startStubEms } from './stub-ems.ts';

const testCtx = createTestContext({ modules: ['ems'], boot: true });

const settled = async (done: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  for (let tries = 0; tries < 300; tries++) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never: ${what}`);
};

Deno.test({ name: 'stream-transcode', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const ems = startStubEms();
  const at = `CFG_EMS_URL=${ems.url} CFG_EMS_FILES_ADDRESS=ein.test:2224`;

  try {
    await client.execString('mkdir -p /tmp/cams && mknode -t stream /tmp/cams/porch.ts --as mimetype=video/mp2t');
    let started: TranscodeStream;

    await t.step('start grants the media service the stream read and one it makes to write', async () => {
      started = await client.execJson<TranscodeStream>(`${at} stream-transcode start /tmp/cams/porch.ts /tmp/cams/porch.h264.ts --idle=600`);
      assertMatch(started.id, /^transcode-[0-9a-f]{16}$/);
      assertEquals([started.source, started.output], ['/tmp/cams/porch.ts', '/tmp/cams/porch.h264.ts']);
      const made = await vfs.get(ADMIN_ACCESS, '/tmp/cams/porch.h264.ts');
      assertEquals([made.type, made.attrs.mimetype], ['stream', 'video/mp2t']);
      assertEquals(ems.transcodes.get(started.id), { source: '/tmp/cams/porch.ts', output: '/tmp/cams/porch.h264.ts' });
      const put = ems.requests.find((request) => request.op === 'transcodes.put')!;
      const names = put.body as { source: { path: string }; output: { path: string }; format: string };
      assertEquals(names.format, 'mpegts');
      assertEquals(filesState().names.get(names.output.path)?.mode, 'write');
      assertEquals(filesState().names.get(names.source.path)?.mode, 'read');
    });

    await t.step('list shows it as the media service has it; stop ends it there and its names', async () => {
      const listed = await client.execJson<TranscodeStream[]>(`${at} stream-transcode list`);
      assertEquals(listed.map((each) => [each.id, each.state, each.readers]), [[started.id, 'running', 0]]);
      const names = ems.requests.find((request) => request.op === 'transcodes.put')!.body as { output: { path: string } };
      await client.execJson(`${at} stream-transcode stop ${started.id}`);
      assertEquals(ems.transcodes.size, 0);
      assert(!filesState().names.has(names.output.path));
      assertEquals(await client.execJson(`${at} stream-transcode list`), []);
    });

    await t.step("without an output, fragmented MP4 is written into a node made for it, the caller's alone, gone once it stops", async () => {
      const made = await client.execJson<TranscodeStream>(`${at} stream-transcode start /tmp/cams/porch.ts --idle=600`);
      assertEquals(made.output, `/tmp/stream-transcodes/${made.id}.mp4`);
      const node = await vfs.get(ADMIN_ACCESS, made.output);
      assertEquals([node.type, node.attrs.mimetype, node.props.mode & 0o777], ['stream', 'video/mp4', 0o600]);
      assertEquals((ems.requests.findLast((request) => request.op === 'transcodes.put')!.body as { format: string }).format, 'mp4');
      await client.execJson(`${at} stream-transcode stop ${made.id}`);
      assertEquals(await vfs.get(ADMIN_ACCESS, made.output).then(() => 'there', () => 'gone'), 'gone');
    });

    await t.step('an output named .mp4 is made and written as fragmented MP4', async () => {
      const named = await client.execJson<TranscodeStream>(`${at} stream-transcode start /tmp/cams/porch.ts /tmp/cams/porch.h264.mp4 --idle=600`);
      assertEquals((await vfs.get(ADMIN_ACCESS, '/tmp/cams/porch.h264.mp4')).attrs.mimetype, 'video/mp4');
      assertEquals((ems.requests.findLast((request) => request.op === 'transcodes.put')!.body as { format: string }).format, 'mp4');
      await client.execJson(`${at} stream-transcode stop ${named.id}`);
    });

    await t.step('a source that is no stream is refused', async () => {
      await client.execString('echo note > /tmp/cams/note.txt');
      await testCommands(client).shouldFailWith(`${at} stream-transcode start /tmp/cams/note.txt /tmp/cams/out.ts`, 'not a stream');
      await testCommands(client).shouldFailWith(`${at} stream-transcode start /tmp/cams/porch.ts /tmp/cams/note.txt`, 'not a stream');
    });

    await t.step('a transcode nobody reads for its idle seconds stops', async () => {
      const idle = await client.execJson<TranscodeStream>(`${at} stream-transcode start /tmp/cams/porch.ts /tmp/cams/porch.h264.ts --idle=1`);
      await settled(() => !ems.transcodes.has(idle.id), 'the idle transcode stops');
    });
  } finally {
    await ems.close();
    client.close();
    await testCtx.teardown();
  }
});
