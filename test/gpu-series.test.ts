/**
 * The GPU series end to end, without a media service: what `gpu-sampler` does with a reading —
 * the same shell lines as its `start.sh`, creating the log on the first one and appending — and
 * what `ems-gpu` makes of it for the dashboard's panel.
 */

import { assertEquals } from '@std/assert';
import { createTestContext, testCommands } from '@ein/testing';
import type { EmsGpu } from '@ems/api';

const testCtx = createTestContext({ modules: ['ems'] });

Deno.test({
  name: 'gpu series',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  try {
    await t.step('no reading yet is no GPU, not an idle one', async () => {
      assertEquals(await client.execJson<EmsGpu>('ems-gpu'), null);
    });

    await t.step("the sampler's lines create the log and append to it; ems-gpu reads the latest", async () => {
      const record = (sample: string) =>
        cmd.shouldSucceed([
          'log="$LOGS_PATH/metrics/gpu"',
          'if [ ! -e "$log" ]; then',
          '  mkdir -p "$LOGS_PATH/metrics"',
          `  mklog -r '7 day' "$log"`,
          'fi',
          `echo '${sample}' >> "$log"`,
        ].join('\n'));

      await record('{"utilPct":10,"memUsedMb":1000,"memTotalMb":16000,"tempC":40}');
      await record('{"utilPct":80,"memUsedMb":8000,"memTotalMb":16000,"tempC":65}');

      const gpu = await client.execJson<EmsGpu>('ems-gpu');
      assertEquals(gpu && { utilPct: gpu.utilPct, tempC: gpu.tempC, vramPercent: gpu.vramPercent }, { utilPct: 80, tempC: 65, vramPercent: 50 });
      assertEquals(gpu?.utilSeries.map((point) => point.value), [10, 80]);
      assertEquals(gpu?.vramSeries.map((point) => point.value), [6.25, 50]);
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
