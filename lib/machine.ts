/**
 * The machine an instance of the media service runs on, as a device: `/dev/ems` for the primary,
 * `/dev/ems-<name>` for another, of class `host`, driven by the `ems` driver the `ems-sampler`
 * service registers. Its readings are what the instance's `GET /v0/health` says of its machine: the
 * card (`nvidia-smi`, whole-card, not what torch holds), the machine's memory and its CPU. It is
 * its own device even when EiN runs on the same machine, since it is that machine as EMS sees it.
 * Named like core's host device and other hosts (`cpu`, `load`, `memory-used`), with `gpu…` and
 * `vram…` for the card.
 *
 * Only the administrators see it: it is in their group, not the devices group. What EMS holds and
 * does (its models, queues, workers) is not here but in the `ems-models` series and `ems-status`.
 */

import { ADMIN_ACCESS, type Command, type Driver, type ModuleDevices, type NodeVFS, readBuckets, readTail } from '@ein/client';
import type { EndpointAttrs } from '@ein/api';
import { PRIMARY } from './instances.ts';

export const EMS_DRIVER = 'ems';

export const emsDriver: Driver = {
  description: 'The machine the media service runs on: its card, memory and CPU, from its health (the ems-sampler service)',
  module: 'ems',
};

/** The device of an instance's machine: `ems` for the primary, `ems-<name>` for another. */
export const machineDevice = (instance: string): string => instance === PRIMARY ? 'ems' : `ems-${instance}`;

/** The machine's CPU time over all cores, in clock ticks, as EMS's health counts it. */
type CpuTicks = { busy: number; total: number };

/** A reading of the machine: its endpoint, the endpoint's attrs and the value. GB are 1024³ bytes, as EiN shows bytes. */
type Reading = { endpoint: string; attrs: EndpointAttrs; value: number };

const FAST = '30 day';
const SLOW = '365 day';

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

/** The share of the machine's CPU busy between two counts of its ticks; none when they started over. */
export const cpuPercent = (before: CpuTicks, now: CpuTicks): number | undefined => {
  const total = now.total - before.total;
  if (total <= 0 || now.busy < before.busy) return undefined;
  return Math.min(100, Math.max(0, (now.busy - before.busy) / total * 100));
};

/** The CPU ticks of a health answer (`cpu`, API 0.3.4), or none. */
const cpuTicksOf = (health: unknown): CpuTicks | undefined => {
  const cpu = record(record(health).cpu);
  const busy = finite(cpu.busy_ticks);
  const total = finite(cpu.total_ticks);
  return busy !== undefined && total !== undefined ? { busy, total } : undefined;
};

/**
 * The readings a health answer gives, in EMS's own field names turned into endpoints; `cpu` is the
 * share busy since `before`, the ticks of the answer before. The card's only where EMS sees one:
 * no card is no reading, never an idle one.
 */
export const machineReadings = (health: unknown, before?: CpuTicks): Reading[] => {
  const body = record(health);
  const gpu = record(body.gpu);
  const memory = record(body.memory);
  const cpu = record(body.cpu);
  const out: Reading[] = [];
  const add = (endpoint: string, attrs: EndpointAttrs, value: number | undefined, places = 1) => {
    if (value !== undefined) out.push({ endpoint, attrs, value: round(value, places) });
  };

  const util = finite(gpu.util_pct);
  if (util !== undefined) {
    add('gpu', { label: 'GPU', unit: '%', retention: FAST }, util);
    add('decoder', { label: 'video decoder', unit: '%', retention: FAST }, finite(gpu.dec_pct));
    add('encoder', { label: 'video encoder', unit: '%', retention: FAST }, finite(gpu.enc_pct));
    const used = finite(gpu.mem_used_mb);
    const total = finite(gpu.mem_total_mb);
    if (used !== undefined && total) {
      add('vram-used', { label: 'VRAM used', unit: '%', retention: FAST }, used / total * 100);
      add('vram-total', { label: 'VRAM', unit: 'GB', category: 'diagnostic', retention: SLOW }, total / 1024);
    }
    add('gpu-temperature', { label: 'GPU temperature', unit: '°C', deviceClass: 'temperature', category: 'diagnostic', retention: FAST }, finite(gpu.temp_c));
    add('gpu-power', { label: 'GPU power', unit: 'W', deviceClass: 'power', category: 'diagnostic', retention: FAST }, finite(gpu.power_w));
    add('gpu-power-limit', { label: 'GPU power limit', unit: 'W', category: 'diagnostic', retention: SLOW }, finite(gpu.power_limit_w));
  }

  const totalMb = finite(memory.total_mb);
  const availableMb = finite(memory.available_mb);
  if (totalMb && availableMb !== undefined) {
    add('memory-used', { label: 'memory used', unit: '%', retention: FAST }, (totalMb - availableMb) / totalMb * 100);
  }
  if (totalMb) add('memory-total', { label: 'memory', unit: 'GB', category: 'diagnostic', retention: SLOW }, totalMb / 1024);

  const now = cpuTicksOf(health);
  add('cpu', { label: 'CPU', unit: '%', retention: FAST }, before && now ? cpuPercent(before, now) : undefined);
  add('load', { label: 'load', category: 'diagnostic', retention: FAST }, finite(cpu.load1), 2);
  return out;
};

/**
 * Writes each instance's machine to its device: its readings from a health answer, and whether EMS
 * answered. The device is made on the first answer, so an instance that never answered has none.
 * What it made is remembered until a write fails, so a device forgotten meanwhile is made again on
 * the next answer.
 */
export class EmsMachines {
  private readonly made = new Set<string>();
  private readonly ticks = new Map<string, CpuTicks>();

  constructor(private readonly sys: { vfs: NodeVFS; devices: ModuleDevices }) {}

  /** An instance's health answer, or `null` when it did not answer. */
  async write(instance: string, health: unknown): Promise<void> {
    const device = machineDevice(instance);
    try {
      if (health === null) {
        if (await this.sys.vfs.exists(ADMIN_ACCESS, `/dev/${device}`)) await this.sys.devices.online(ADMIN_ACCESS, device, false);
        return;
      }
      if (!this.made.has(device)) await this.ensureDevice(device, instance, record(record(health).gpu).name);
      const before = this.ticks.get(device);
      const now = cpuTicksOf(health);
      if (now) this.ticks.set(device, now);
      for (const reading of machineReadings(health, before)) {
        const key = `${device}/${reading.endpoint}`;
        if (!this.made.has(key)) {
          await this.sys.devices.ensureEndpoint(ADMIN_ACCESS, device, reading.endpoint, 'log', reading.attrs);
          this.made.add(key);
        }
        await this.sys.devices.append(ADMIN_ACCESS, device, reading.endpoint, reading.value);
      }
      await this.sys.devices.online(ADMIN_ACCESS, device, true);
    } catch (error) {
      for (const key of [...this.made]) if (key === device || key.startsWith(`${device}/`)) this.made.delete(key);
      throw error;
    }
  }

  /** The device, in the administrators' group: its endpoints are made in its group, so they are too. */
  private async ensureDevice(device: string, instance: string, card: unknown): Promise<void> {
    const path = await this.sys.devices.ensureDevice(ADMIN_ACCESS, device, {
      label: instance === PRIMARY ? 'Media service' : `Media service ${instance}`,
      class: 'host',
      driver: EMS_DRIVER,
      ...(typeof card === 'string' && card ? { model: card } : {}),
    });
    const node = await this.sys.vfs.get(ADMIN_ACCESS, path);
    if (node.props.gid !== ADMIN_ACCESS.gid) await this.sys.vfs.update(ADMIN_ACCESS, path, { props: { gid: ADMIN_ACCESS.gid } });
    this.made.add(device);
  }
}

/**
 * One of an instance's machine readings: its latest value within the last `windowMs`, and that
 * window averaged into at most `points`. A reading older than the window is none: a machine not
 * heard from in hours is not shown as it was.
 */
export const readMachine = async (
  cmd: Pick<Command, 'sys' | 'access'>,
  instance: string,
  endpoint: string,
  windowMs: number,
  points = 120,
): Promise<{ now?: number; series: { at: number; value: number }[] }> => {
  const path = `/dev/${machineDevice(instance)}/${endpoint}`;
  try {
    const [latest, buckets] = await Promise.all([
      readTail<{ value?: unknown }>(cmd.sys.vfs, cmd.access, path, 1),
      readBuckets(cmd.sys.vfs, cmd.access, path, {
        since: new Date(Date.now() - windowMs),
        bucketSeconds: Math.max(15, Math.ceil(windowMs / 1000 / points)),
        aggregate: 'avg',
        field: ['value'],
      }),
    ]);
    const now = latest[0] && latest[0].at >= Date.now() - windowMs ? latest[0].value?.value : undefined;
    const series = buckets.flatMap((bucket) => typeof bucket.value === 'number' ? [{ at: bucket.at, value: bucket.value }] : []);
    return { now: typeof now === 'number' ? now : undefined, series };
  } catch {
    // No device yet, or not one this account may read.
    return { series: [] };
  }
};
