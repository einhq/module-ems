/**
 * GPU probe — EMS's `GET /v0/health`, or nothing.
 *
 * The card is EMS's: this process has no device and never looks for one. A
 * sample is the whole card as an instance of the media service reports it — utilization (and the
 * video decoder's and encoder's, when EMS reports them), memory and temperature, not what torch has
 * allocated — read from the instance's address with its key.
 *
 * Absent-or-a-sample: no EMS address, an EMS that is not answering, or one whose
 * health carries no `util_pct` (it cannot see a card) returns undefined rather
 * than zeroes that look like an idle card.
 */

import type { GpuSample } from '@ems/api';
import type { EmsInstance } from './instances.ts';
/** How long one health request may take — a probe runs every 15 s and must not pile up. */
const EMS_TIMEOUT_MS = 5000;

/** EMS's `health.gpu`, in its own field names. Anything else in the body is not read here. */
type EmsHealthGpu = {
  util_pct?: unknown;
  dec_pct?: unknown;
  enc_pct?: unknown;
  mem_used_mb?: unknown;
  mem_total_mb?: unknown;
  temp_c?: unknown;
  power_w?: unknown;
  power_limit_w?: unknown;
};

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The whole-card fields of an EMS health answer as a sample, or undefined when a required one is missing. */
export const gpuSampleFromHealth = (body: unknown): GpuSample | undefined => {
  const gpu = (body as { gpu?: EmsHealthGpu } | null)?.gpu;
  if (!gpu || typeof gpu !== 'object') return undefined;
  const utilPct = finite(gpu.util_pct);
  const memUsedMb = finite(gpu.mem_used_mb);
  const memTotalMb = finite(gpu.mem_total_mb);
  const tempC = finite(gpu.temp_c);
  if (utilPct === undefined || memUsedMb === undefined || memTotalMb === undefined || tempC === undefined) return undefined;
  const decPct = finite(gpu.dec_pct);
  const encPct = finite(gpu.enc_pct);
  const powerW = finite(gpu.power_w);
  const powerLimitW = finite(gpu.power_limit_w);
  return {
    utilPct,
    ...(decPct !== undefined ? { decPct } : {}),
    ...(encPct !== undefined ? { encPct } : {}),
    memUsedMb,
    memTotalMb,
    tempC,
    ...(powerW !== undefined ? { powerW } : {}),
    ...(powerLimitW !== undefined ? { powerLimitW } : {}),
  };
};

/** One reading, asked of `instance`. */
export const sampleGpu = async (instance: EmsInstance): Promise<GpuSample | undefined> => {
  try {
    const response = await fetch(`${instance.url}/v0/health`, {
      headers: instance.key ? { authorization: `Bearer ${instance.key}` } : {},
      signal: AbortSignal.timeout(EMS_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return gpuSampleFromHealth(await response.json());
  } catch {
    // Not answering, or answering with something that is not JSON: no sample this tick.
    return undefined;
  }
};
