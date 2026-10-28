/**
 * `GET /v0/health` as `ems-status` answers it: camelCase, `families` as a list, and the two
 * views of the card under one `gpu`.
 */
import type { HealthCheck } from '@ein/client';
import type { EmsFamily, EmsModelSize, EmsStatus, EmsWorkerMemory } from '@ems/api';
import type { HealthResult } from '@ems/client';

/** Seconds as a compact age. */
export const age = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

const sizeOf = (size: { vram_mb?: number; ram_mb?: number; load_seconds?: number }): EmsModelSize => ({
  ...(size.vram_mb !== undefined ? { vramMb: size.vram_mb } : {}),
  ...(size.ram_mb !== undefined ? { ramMb: size.ram_mb } : {}),
  ...(size.load_seconds !== undefined ? { loadSeconds: size.load_seconds } : {}),
});

const memoryOf = (process: { rss_mb?: number; max_rss_mb?: number; recycles?: number }): EmsWorkerMemory => ({
  ...(process.rss_mb !== undefined ? { rssMb: process.rss_mb } : {}),
  ...(process.max_rss_mb !== undefined ? { maxRssMb: process.max_rss_mb } : {}),
  ...(process.recycles ? { recycles: process.recycles } : {}),
});

/** EMS's `families` map as a list, in camelCase, the way every other command answers. */
const familiesOf = (result: HealthResult): EmsFamily[] =>
  Object.entries(result.families).map(([name, family]) => {
    const plan = result.card?.plan?.[name];
    return {
      name,
      ...(family.model ? { model: family.model } : {}),
      ...(family.device ? { device: family.device } : {}),
      ...(family.purpose ? { purpose: family.purpose } : {}),
      ...(family.ops ? { ops: family.ops } : {}),
      pinned: family.pinned ?? false,
      running: family.running ?? false,
      waiting: family.waiting ?? 0,
      copies: (family.copies ?? []).map((copy) => ({
        key: copy.key,
        state: copy.state,
        ...(copy.device ? { device: copy.device } : {}),
        ...(copy.since ? { since: copy.since } : {}),
        ...(copy.last_used ? { lastUsed: copy.last_used } : {}),
        ...(copy.worker ? { worker: copy.worker } : {}),
        ...sizeOf(copy),
      })),
      ...(family.measured ? { measured: Object.fromEntries(Object.entries(family.measured).map(([key, size]) => [key, sizeOf(size)])) } : {}),
      ...(plan ? { plan: { busy: plan.busy, quiet: plan.quiet, ...(plan.why ? { why: plan.why } : {}) } } : {}),
    };
  });

export const statusFromHealth = (result: HealthResult, url: string): Extract<EmsStatus, { running: true }> => {
  const loaded = Object.entries(result.models).map(([family, m]) => (m.device ? `${family}:${m.device}` : family));
  const gpu = result.gpu;
  return {
    running: true as const,
    url,
    api: result.api,
    ...(result.build ? { build: result.build } : {}),
    uptime: result.uptime,
    worker: result.worker,
    loaded,
    degraded: result.degraded ?? [],
    families: familiesOf(result),
    requests: result.requests,
    ...(result.card
      ? {
        card: {
          mode: result.card.mode,
          ...(result.card.since !== undefined ? { since: result.card.since } : {}),
          ...(result.card.quiet_after !== undefined ? { quietAfter: result.card.quiet_after } : {}),
          ...(result.card.last_batch !== undefined ? { lastBatch: result.card.last_batch } : {}),
          ...(result.card.batch_in_flight !== undefined ? { batchInFlight: result.card.batch_in_flight } : {}),
          searchOnCard: result.card.search_on_card ?? [],
        },
      }
      : {}),
    gpu: {
      present: gpu.present,
      ...(gpu.name ? { name: gpu.name } : {}),
      ...(gpu.driver ? { driver: gpu.driver } : {}),
      ...(gpu.util_pct !== undefined ? { utilPct: gpu.util_pct } : {}),
      ...(gpu.dec_pct !== undefined ? { decPct: gpu.dec_pct } : {}),
      ...(gpu.enc_pct !== undefined ? { encPct: gpu.enc_pct } : {}),
      ...(gpu.mem_used_mb !== undefined ? { memUsedMb: gpu.mem_used_mb } : {}),
      ...(gpu.mem_total_mb !== undefined ? { memTotalMb: gpu.mem_total_mb } : {}),
      ...(gpu.temp_c !== undefined ? { tempC: gpu.temp_c } : {}),
      ...(gpu.power_w !== undefined ? { powerW: gpu.power_w } : {}),
      ...(gpu.power_limit_w !== undefined ? { powerLimitW: gpu.power_limit_w } : {}),
      ...(gpu.processes ? { processes: gpu.processes.map((p) => ({ pid: p.pid, usedMb: p.used_mb, ...(p.worker ? { worker: p.worker } : {}) })) } : {}),
    },
    ...(result.gpu.vram_allocated_mb !== undefined ? { vramAllocatedMb: result.gpu.vram_allocated_mb } : {}),
    ...(result.gpu.vram_reserved_mb !== undefined ? { vramReservedMb: result.gpu.vram_reserved_mb } : {}),
    ...(result.process?.rss_mb !== undefined ? { rssMb: result.process.rss_mb } : {}),
    ...(result.process?.max_rss_mb !== undefined ? { maxRssMb: result.process.max_rss_mb } : {}),
    ...(result.process?.recycles ? { recycles: result.process.recycles } : {}),
    ...(result.process?.query ? { queryWorker: memoryOf(result.process.query) } : {}),
    ...(result.queues ? { queues: result.queues } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
};

/**
 * What `health` asks about EMS (`ems-status --checks`, the `ems-link` service's `checkCommand`):
 * whether it answers and its model worker runs, each degradation, and the card. Nothing fails
 * while EMS merely restarts or is busy — the steps that need it wait — except a card the host is
 * meant to have and does not see, which a person has to put back.
 */
export const checksOf = (status: EmsStatus): HealthCheck[] => {
  if (!status.running) {
    return [{ name: 'ems', state: 'warn', reason: `${status.url} is not answering; work that needs it waits` }];
  }
  const build = status.build?.commit ? ` ${status.build.commit.slice(0, 7)}` : '';
  const checks: HealthCheck[] = [{ name: 'ems', state: 'ok', reason: `EMS${build} answering, up ${age(status.uptime)}` }];
  if (!status.worker.running) checks.push({ name: 'ems worker', state: 'warn', reason: 'the model worker is down; EMS starts it again' });
  for (const d of status.degraded) {
    const since = d.since ? ` for ${age(Date.now() / 1000 - d.since)}` : '';
    const state = d.what === 'gpu' ? 'fail' : 'warn';
    checks.push({ name: `ems ${d.what}`, state, reason: `${d.reason}${since}` });
  }
  if (status.card && status.card.mode !== 'off') {
    const search = status.card.searchOnCard.length > 0 ? `, search on it: ${status.card.searchOnCard.join(', ')}` : '';
    checks.push({ name: 'ems card', state: 'ok', reason: `${status.card.mode}${search}` });
  }
  return checks;
};
