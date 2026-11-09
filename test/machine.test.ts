/**
 * The media service's machine as a device: the readings a health answer gives, the device they make
 * in the administrators' group, online while EMS answers, what `ems-gpu` and `ems-memory` read back
 * from it, and the `ems-sampler` service driving it from a media service's health.
 */

import { assertEquals } from '@std/assert';
import type { DeviceInfo } from '@ein/api';
import { ADMIN_ACCESS, SystemTestHarness } from '@ein/testing';
import type { EmsGpu, EmsMemory } from '@ems/api';
import { cpuPercent, EmsMachines, machineDevice, machineReadings } from '../lib/machine.ts';
import { startStubEms } from './stub-ems.ts';

const HEALTH = {
  ok: true,
  gpu: { present: true, util_pct: 37.44, dec_pct: 21, enc_pct: 0, mem_used_mb: 4096, mem_total_mb: 16384, temp_c: 51, power_w: 21.6, power_limit_w: 180, name: 'A test card' },
  memory: { total_mb: 32768, available_mb: 8192, used_mb: 9120, limit_mb: 24576 },
  cpu: { busy_ticks: 1000, total_ticks: 4000, cores: 6, load1: 3.123 },
};

Deno.test('machineReadings: the card, the memory and the CPU as endpoints, in their units', () => {
  const readings = machineReadings(HEALTH, { busy: 900, total: 3800 });
  assertEquals(Object.fromEntries(readings.map((reading) => [reading.endpoint, reading.value])), {
    gpu: 37.4,
    decoder: 21,
    encoder: 0,
    'vram-used': 25,
    'vram-total': 16,
    'gpu-temperature': 51,
    'gpu-power': 21.6,
    'gpu-power-limit': 180,
    'memory-used': 75,
    'memory-total': 32,
    cpu: 50,
    load: 3.12,
  });
});

Deno.test('machineReadings: no card is no card reading, and no CPU share from one answer', () => {
  const readings = machineReadings({ ok: true, gpu: { present: false }, memory: HEALTH.memory, cpu: HEALTH.cpu });
  assertEquals(readings.map((reading) => reading.endpoint), ['memory-used', 'memory-total', 'load']);
  assertEquals(machineReadings({ ok: true }), []);
});

Deno.test('cpuPercent: the share busy between two counts; none when they started over', () => {
  assertEquals(cpuPercent({ busy: 0, total: 0 }, { busy: 25, total: 100 }), 25);
  assertEquals(cpuPercent({ busy: 50, total: 100 }, { busy: 10, total: 20 }), undefined);
  assertEquals(cpuPercent({ busy: 50, total: 100 }, { busy: 50, total: 100 }), undefined);
});

Deno.test('machineDevice: ems for the primary, ems-<name> for another', () => {
  assertEquals([machineDevice('main'), machineDevice('laptop')], ['ems', 'ems-laptop']);
});

const harness = new SystemTestHarness({ boot: true, ssh: false, modules: ['ems'] });

Deno.test({ name: "the media service's machine", sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs, devices } = await harness.start();
  const admin = await harness.createShellClient();
  const machines = new EmsMachines({ vfs, devices });
  const ems = startStubEms({ health: HEALTH });

  try {
    await t.step('no reading is no GPU, not an idle one', async () => {
      assertEquals(await admin.execJson<EmsGpu>('ems-gpu'), null);
      assertEquals(await admin.execJson<EmsMemory>('ems-memory'), null);
    });

    await t.step("a health answer makes the device, the administrators' alone, online", async () => {
      await machines.write('main', HEALTH);
      await machines.write('main', { ...HEALTH, cpu: { ...HEALTH.cpu, busy_ticks: 1500, total_ticks: 5000 } });
      const info = await admin.execJson<DeviceInfo>('device-show ems');
      assertEquals([info.label, info.class, info.driver, info.model, info.online], ['Media service', 'host', 'ems', 'A test card', true]);
      const values = Object.fromEntries(info.endpointList.map((ep) => [ep.name, ep.last?.value]));
      assertEquals([values.gpu, values['vram-used'], values.cpu, values['memory-used']], [37.4, 25, 50, 75]);
      const node = await vfs.get(ADMIN_ACCESS, '/dev/ems');
      const endpoint = await vfs.get(ADMIN_ACCESS, '/dev/ems/gpu');
      assertEquals([node.props.gid, endpoint.props.gid, endpoint.attrs.retention], [0, 0, '30 day']);
    });

    await t.step('ems-gpu and ems-memory read the card and the memory back from it', async () => {
      const gpu = await admin.execJson<EmsGpu>('ems-gpu');
      assertEquals(
        gpu && [gpu.utilPct, gpu.memUsedMb, gpu.memTotalMb, gpu.tempC, gpu.vramPercent, gpu.powerW, gpu.powerLimitW, gpu.decPct],
        [37.4, 4096, 16384, 51, 25, 21.6, 180, 21],
      );
      assertEquals(gpu?.utilSeries.map((point) => point.value), [37.4]);
      const memory = await admin.execJson<EmsMemory>('ems-memory');
      assertEquals(memory && [memory.usedMb, memory.totalMb, memory.percent], [24576, 32768, 75]);
    });

    await t.step("another instance's machine is a device of its own, and its gauges carry its name", async () => {
      await admin.execString('mkdir -p /etc/ems.d && mkfile /etc/ems.d/laptop && echo \'{"url":"http://127.0.0.1:1"}\' > /etc/ems.d/laptop');
      await machines.write('laptop', { ...HEALTH, gpu: { ...HEALTH.gpu, util_pct: 80 } });
      assertEquals((await admin.execJson<EmsGpu>('ems-gpu --instance laptop'))?.utilPct, 80);
      const gauges = await admin.execJson<{ label: string }[]>('ems-gpu --gauge');
      assertEquals(gauges.map((gauge) => gauge.label), ['GPU', 'VRAM', 'GPU laptop', 'VRAM laptop']);
    });

    await t.step('no answer is the device offline', async () => {
      await machines.write('main', null);
      assertEquals((await admin.execJson<DeviceInfo>('device-show ems')).online, false);
    });

    await t.step("the ems-sampler service drives it from the media service's health", async () => {
      await admin.execString('device-forget ems');
      await admin.execString(`config set CFG_EMS_URL ${ems.url} && service restart ems-sampler`);
      let info: DeviceInfo | undefined;
      for (let i = 0; i < 50 && !info?.endpointList.some((ep) => ep.name === 'gpu'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        info = await admin.execJson<DeviceInfo>('device-show ems').catch(() => undefined);
      }
      assertEquals([info?.driverRunning, info?.online, info?.endpointList.find((ep) => ep.name === 'gpu')?.last?.value], [true, true, 37.4]);
    });
  } finally {
    await ems.close();
    admin.close();
    await harness.stop();
  }
});
