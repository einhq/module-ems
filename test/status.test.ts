import { assertEquals } from '@std/assert';
import type { HealthResult } from '@ems/client';
import { checksOf, statusFromHealth } from '@ems/status';

const base: HealthResult = {
  ok: true,
  api: '3.3.0',
  uptime: 60,
  gpu: { present: true },
  models: {},
  worker: { running: true, restarts: 0 },
  families: {},
  requests: [],
};

Deno.test('every family is listed, loaded or not, with its copies in camelCase', () => {
  const status = statusFromHealth({
    ...base,
    models: { insightface: { loaded: true, device: 'cuda' } },
    families: {
      insightface: {
        model: 'a-face-model',
        device: 'auto',
        pinned: false,
        running: true,
        waiting: 2,
        copies: [{ key: 'insightface:cuda', state: 'loaded', since: 100, last_used: 200, device: 'cuda', worker: 'batch' }],
      },
      whisper: { model: 'large-v3', device: 'auto', pinned: false, copies: [] },
      'text-query': { model: 'an-embedder', device: 'cpu', pinned: true, copies: [{ key: 'text-query:cpu', state: 'loading', since: 150, device: 'cpu' }] },
    },
    requests: [{ op: 'faces.detect', lane: 'models', interactive: false, queued: 190, started: 195 }],
    build: { version: '2.0.0a0', commit: 'abc1234' },
  }, 'http://ems');

  assertEquals(status.loaded, ['insightface:cuda']);
  assertEquals(status.families, [
    {
      name: 'insightface',
      model: 'a-face-model',
      device: 'auto',
      pinned: false,
      running: true,
      waiting: 2,
      copies: [{ key: 'insightface:cuda', state: 'loaded', device: 'cuda', since: 100, lastUsed: 200, worker: 'batch' }],
    },
    { name: 'whisper', model: 'large-v3', device: 'auto', pinned: false, running: false, waiting: 0, copies: [] },
    {
      name: 'text-query',
      model: 'an-embedder',
      device: 'cpu',
      pinned: true,
      running: false,
      waiting: 0,
      copies: [{ key: 'text-query:cpu', state: 'loading', device: 'cpu', since: 150 }],
    },
  ]);
  assertEquals(status.requests[0].op, 'faces.detect');
  assertEquals(status.build, { version: '2.0.0a0', commit: 'abc1234' });
});

Deno.test('the whole card and torch accounting are kept apart', () => {
  const status = statusFromHealth({
    ...base,
    gpu: { present: true, util_pct: 40, mem_used_mb: 8000, mem_total_mb: 16000, temp_c: 55, vram_allocated_mb: 5000, vram_reserved_mb: 6000 },
  }, 'http://ems');
  assertEquals(status.gpu, { present: true, utilPct: 40, memUsedMb: 8000, memTotalMb: 16000, tempC: 55 });
  assertEquals([status.vramAllocatedMb, status.vramReservedMb], [5000, 6000]);
});

Deno.test('the card, its processes, the sizes and the query worker come through in camelCase', () => {
  const status = statusFromHealth({
    ...base,
    gpu: { present: true, name: 'A Card', driver: '600.1', power_w: 20.5, power_limit_w: 180, processes: [{ pid: 49, used_mb: 1800, worker: 'batch' }] },
    process: { rss_mb: 7000, query: { rss_mb: 1500, max_rss_mb: 6144 } },
    families: {
      whisper: {
        purpose: 'Transcribes speech.',
        ops: ['speech.transcribe'],
        copies: [{ key: 'whisper:cuda:float16', state: 'loaded', vram_mb: 3000, ram_mb: 600, load_seconds: 15.5 }],
        measured: { 'whisper:cuda:float16': { vram_mb: 3000, ram_mb: 600, load_seconds: 15.5 } },
      },
    },
    requests: [{ op: 'speech.transcribe', lane: 'models', interactive: false, queued: 1, started: 2, family: 'whisper' }],
  }, 'http://ems');

  assertEquals(status.gpu?.name, 'A Card');
  assertEquals(status.gpu?.processes, [{ pid: 49, usedMb: 1800, worker: 'batch' }]);
  assertEquals([status.gpu?.powerW, status.gpu?.powerLimitW, status.gpu?.driver], [20.5, 180, '600.1']);
  assertEquals(status.queryWorker, { rssMb: 1500, maxRssMb: 6144 });
  const [whisper] = status.families;
  assertEquals([whisper.purpose, whisper.ops], ['Transcribes speech.', ['speech.transcribe']]);
  assertEquals(whisper.copies[0], { key: 'whisper:cuda:float16', state: 'loaded', vramMb: 3000, ramMb: 600, loadSeconds: 15.5 });
  assertEquals(whisper.measured, { 'whisper:cuda:float16': { vramMb: 3000, ramMb: 600, loadSeconds: 15.5 } });
  assertEquals(status.requests[0].family, 'whisper');
});

Deno.test('the card mode comes through, and each family carries where it runs in each mode', () => {
  const status = statusFromHealth({
    ...base,
    families: {
      insightface: { device: 'auto', pinned: false, copies: [] },
      'siglip-text': { device: 'cpu', pinned: true, copies: [] },
    },
    card: {
      mode: 'busy',
      since: 100,
      quiet_after: 600,
      last_batch: 150,
      batch_in_flight: 1,
      search_on_card: [],
      plan: {
        insightface: { busy: 'card', quiet: 'unloaded' },
        'siglip-text': { busy: 'cpu', quiet: 'cpu', why: '3500 MB free, needs 6324 MB' },
      },
    },
  }, 'http://ems');

  assertEquals(status.card, { mode: 'busy', since: 100, quietAfter: 600, lastBatch: 150, batchInFlight: 1, searchOnCard: [] });
  assertEquals(status.families.map((family) => [family.name, family.plan]), [
    ['insightface', { busy: 'card', quiet: 'unloaded' }],
    ['siglip-text', { busy: 'cpu', quiet: 'cpu', why: '3500 MB free, needs 6324 MB' }],
  ]);
});

Deno.test('without a shared card there is no mode and no plan', () => {
  const status = statusFromHealth({ ...base, families: { insightface: { copies: [] } } }, 'http://ems');
  assertEquals(status.card, undefined);
  assertEquals(status.families[0].plan, undefined);
});

Deno.test("health's checks: EMS away only waits; a card the host should have and does not see is a person's", () => {
  assertEquals(checksOf({ running: false, url: 'http://ems' }), [
    { name: 'ems', state: 'warn', reason: 'http://ems is not answering; work that needs it waits' },
  ]);

  const checks = checksOf(statusFromHealth({
    ...base,
    uptime: 7200,
    build: { commit: 'abc1234def' },
    worker: { running: false, restarts: 1 },
    degraded: [
      { what: 'gpu', reason: 'this host is meant to have a card, and none is visible' },
      { what: 'whisper', reason: 'no room on the card' },
    ],
  }, 'http://ems'));
  assertEquals(checks.map((check) => [check.name, check.state]), [['ems', 'ok'], ['ems worker', 'warn'], ['ems gpu', 'fail'], ['ems whisper', 'warn']]);
  assertEquals(checks[0].reason, 'EMS abc1234 answering, up 2.0h');
  assertEquals(checks[3].reason, 'no room on the card');
});
