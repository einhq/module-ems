/**
 * `ems-instance`: the primary is the media service settings and cannot be changed here; another
 * instance is a node of the administrator's alone, added, changed and removed by the command, and
 * listed with what it says it is while it answers. `ems-status --checks` asks every instance and
 * names the checks of all but the primary after it.
 */

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { HealthCheck } from '@ein/client';
import type { EmsInstanceRow } from '@ems/api';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from './stub-ems.ts';

const testCtx = createTestContext({ modules: ['ems'] });

Deno.test({ name: 'ems-instance', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const primary = startStubEms({
    capabilities: {
      name: 'fry',
      ops: ['vision.embed', 'speech.transcribe'],
      models: { image_embed: 'siglip2' },
      signatures: { transcribe: 'cuda' },
      limits: { models: 8, tools: 4 },
    },
    health: { gpu: { present: true }, families: {}, requests: [] },
  });
  const laptop = startStubEms({
    capabilities: {
      name: 'laptop',
      ops: ['vision.embed', 'speech.transcribe', 'media.probe'],
      models: { image_embed: 'siglip2' },
      signatures: { transcribe: 'cpu' },
      gpu: { present: false },
      limits: { models: 2, tools: 6 },
      build: { commit: 'abc1234def' },
    },
    // Its capabilities answer and its health does not, as while its model worker starts.
    health: null,
  });
  const at = `CFG_EMS_URL=${primary.url}`;

  try {
    await t.step('only the primary at first, which is changed with config set', async () => {
      assertEquals((await client.execJson<EmsInstanceRow[]>(`${at} ems-instance list`)).map((row) => [row.name, row.primary, row.answering]), [['main', true, true]]);
      await cmd.shouldFailWith(`ems-instance set main --url http://elsewhere:8181`, 'config set');
    });

    await t.step('another is added with its address and key, which no one else reads', async () => {
      await cmd.shouldSucceed(`ems-instance add laptop --url ${laptop.url}/ --key let-me-in --files-address 192.168.1.10:2224`);
      await cmd.shouldFailWith(`ems-instance add laptop --url ${laptop.url}`, 'exists');
      await cmd.shouldFailWith(`ems-instance add desktop --url ${laptop.url}`, 'is laptop already');
      await cmd.shouldFailWith('ems-instance add Desk_top --url http://x:1', 'lower case');
      await cmd.shouldFailWith('ems-instance add desktop --url not-an-address', 'not an http address');
      const node = await vfs.get(ADMIN_ACCESS, '/etc/ems.d/laptop');
      assertEquals(node.props.mode, 0o600);
    });

    await t.step('the list says what each instance is, and what another stamps otherwise than the primary', async () => {
      const rows = await client.execJson<EmsInstanceRow[]>(`${at} ems-instance list`);
      assertEquals(rows[1], {
        name: 'laptop',
        primary: false,
        url: laptop.url,
        filesAddress: '192.168.1.10:2224',
        keySet: true,
        modelSlots: 2,
        cpuSlots: 6,
        answering: true,
        calls: 'laptop',
        ops: ['vision.embed', 'speech.transcribe', 'media.probe'],
        gpu: { present: false },
        build: { commit: 'abc1234def' },
        differs: ['speech.transcribe'],
      });
      assertEquals(laptop.requests.length, 0);
      assertEquals((await client.execString(`${at} ems-instance list --names --others`)).trim(), '["laptop"]');
      assertStringIncludes(await client.execString(`JSON_OUTPUT=0 ${at} ems-instance list`), 'CPU only');
    });

    await t.step('show prints one field, the slots from its limits until they are set', async () => {
      assertEquals((await client.execString(`JSON_OUTPUT=0 ${at} ems-instance show laptop modelSlots`)).trim(), '2');
      await cmd.shouldSucceed('ems-instance set laptop --model-slots 1 --files-address ""');
      assertEquals((await client.execString(`JSON_OUTPUT=0 ${at} ems-instance show laptop modelSlots`)).trim(), '1');
      assertEquals(await client.execJson(`${at} ems-instance show laptop filesAddress`), null);
      await cmd.shouldFailWith('ems-instance set laptop --model-slots none', 'not a number of slots');
    });

    await t.step('the checks ask every instance, another named after it', async () => {
      const checks = await client.execJson<HealthCheck[]>(`${at} ems-status --checks`);
      assertEquals(checks.map((check) => [check.name, check.state]), [['ems', 'ok'], ['ems laptop', 'warn']]);
      assertStringIncludes(checks[1].reason, 'its work goes to the other instances');
    });

    await t.step('removed, it is gone', async () => {
      await cmd.shouldSucceed('ems-instance remove laptop');
      assertEquals(await client.execJson(`${at} ems-instance list --names`), ['main']);
      await cmd.shouldFailWith('ems-instance remove laptop', 'no instance called laptop');
    });
  } finally {
    await primary.close();
    await laptop.close();
    client.close();
    await testCtx.teardown();
  }
});
