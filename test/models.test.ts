import { assertEquals } from '@std/assert';
import type { HealthResult } from '@ems/client';
import { modelsSample, workWaiting } from '@ems/models';
import { statusFromHealth } from '@ems/status';
import { holdingsOf } from '../ui/components/holdings.ts';

/** EMS while the card is quiet: the search models on the card, and in RAM in the query worker; faces in use on the card. */
const quiet: HealthResult = {
  ok: true,
  api: '0.3.1',
  uptime: 60,
  gpu: { present: true },
  models: {},
  worker: { running: true, restarts: 0 },
  card: { mode: 'quiet' },
  families: {
    'siglip-text': {
      pinned: true,
      copies: [
        { key: 'siglip-text:cpu', state: 'loaded', device: 'cpu', worker: 'query', ram_mb: 1700 },
        { key: 'siglip-text:cuda', state: 'loaded', device: 'cuda', worker: 'card', vram_mb: 2800, ram_mb: 276 },
      ],
    },
    faces: { pinned: false, copies: [{ key: 'faces:cuda', state: 'loaded', device: 'cuda', worker: 'batch', vram_mb: 1900 }] },
    whisper: { pinned: false, copies: [] },
  },
  requests: [{ op: 'faces.detect', caller: 'default', lane: 'models', interactive: false, queued: 1, started: 2, family: 'faces' }],
};

Deno.test('a sample says the card mode, each copy and where it is, and the models working', () => {
  const sample = modelsSample(statusFromHealth(quiet, 'http://ems'), { notStarted: 12, inLine: 30 });
  assertEquals(sample.mode, 'quiet');
  assertEquals(sample.copies, [
    { family: 'siglip-text', place: 'ram', worker: 'query', state: 'loaded' },
    { family: 'siglip-text', place: 'card', worker: 'card', state: 'loaded' },
    { family: 'faces', place: 'card', worker: 'batch', state: 'loaded' },
  ]);
  assertEquals(sample.working, ['faces']);
  assertEquals([sample.notStarted, sample.inLine], [12, 30]);
});

Deno.test("EiN's work waiting: the intake pool is not started, the other pools' ready jobs are in line", () => {
  assertEquals(
    workWaiting({ triggers: { ready: 40, claimed: 2 }, media: { ready: 300, claimed: 6 }, staging: { ready: 5, claimed: 0 } }, 'triggers'),
    { notStarted: 42, inLine: 305 },
  );
});

Deno.test("a search model's RAM copy beside its card copy is standby; an indexing model's is not", () => {
  const holdings = holdingsOf(statusFromHealth(quiet, 'http://ems'));
  const ram = holdings.find((holding) => holding.key === 'siglip-text:cpu')!;
  const card = holdings.find((holding) => holding.key === 'siglip-text:cuda')!;
  const faces = holdings.find((holding) => holding.key === 'faces:cuda')!;
  assertEquals([ram.place, ram.mb, ram.search, ram.standby], ['ram', 1700, true, true]);
  assertEquals([card.place, card.mb, card.standby], ['card', 2800, false]);
  assertEquals([faces.working, faces.search, faces.standby], [true, false, false]);
});
