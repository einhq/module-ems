/**
 * What ems offers others through settings: `ems-text-embed`, the text embedder `CFG_TEXT_EMBEDDER`
 * names (ems's `etc/config`), and `ems-status --card`, the card's mode alone for whatever shares
 * the card and follows it.
 */

import { assertEquals } from '@std/assert';
import type { TextEmbedding } from '@ein/api';
import { createTestContext, testCommands } from '@ein/testing';
import { startStubEms } from './stub-ems.ts';

const testCtx = createTestContext({ modules: ['ems'], boot: true });

Deno.test({ name: 'ems commands for others', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  let mode = 'busy';
  const ems = startStubEms({
    capabilities: { models: { text_embed: 'text-model-1' } },
    health: {
      get card() {
        return { mode };
      },
    },
    ops: {
      'text.embed': (body) => ({ result: { embeddings: (body.texts as string[]).map((text) => [text.length, body.role === 'query' ? 1 : 0]) }, producer: 'text-model-1' }),
    },
  });
  const at = `CFG_EMS_URL=${ems.url}`;

  try {
    await t.step('mod setup names ems-text-embed as the text embedder', async () => {
      const entry = await client.execJson<{ value: string; source: string; sourceModule?: string }>('config get CFG_TEXT_EMBEDDER');
      assertEquals([entry.value, entry.source, entry.sourceModule], ['ems-text-embed', 'module', 'ems']);
    });

    await t.step('a vector per text, in order, with the model that made them', async () => {
      assertEquals(await client.execJson<TextEmbedding>(`${at} ems-text-embed --role query hej 'hej då'`), { model: 'text-model-1', vectors: [[3, 1], [6, 1]] });
      assertEquals((await client.execJson<TextEmbedding>(`${at} ems-text-embed hej`)).vectors, [[3, 0]]);
      assertEquals(await client.execJson<TextEmbedding>(`${at} ems-text-embed --model`), { model: 'text-model-1', vectors: [] });
      await cmd.shouldFailWith(`${at} ems-text-embed`, 'missing text');
      await cmd.shouldFailWith('CFG_EMS_URL=http://127.0.0.1:1 ems-text-embed hej', 'ems-text-embed:');
    });

    await t.step('the card mode alone, and a failure when EMS cannot say', async () => {
      assertEquals((await client.execString(`JSON_OUTPUT=0 ${at} ems-status --card`)).trim(), 'busy');
      mode = 'quiet';
      assertEquals(await client.execJson(`${at} ems-status --card`), { mode: 'quiet' });
      assertEquals((await client.exec('CFG_EMS_URL=http://127.0.0.1:1 ems-status --card')).success, false);
    });
  } finally {
    await ems.close();
    client.close();
    await testCtx.teardown();
  }
});
