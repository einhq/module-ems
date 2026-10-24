/**
 * GPU probe — EMS's `GET /v0/health`, or nothing.
 *
 * The card is EMS's: this process has no device and never looks for one. A
 * sample is the whole card as the media service reports it — utilization, memory
 * and temperature as EMS's own `nvidia-smi` sees them, not what torch has
 * allocated — read from `CFG_EMS_URL` with `CFG_EMS_KEY` (`serviceKey`).
 *
 * Absent-or-a-sample: no EMS address, an EMS that is not answering, or one whose
 * health carries no `util_pct` (it cannot see a card) returns undefined rather
 * than zeroes that look like an idle card.
 */

import { serviceKey, type SettingsContext } from '@ein/client';
import type { GpuSample } from '@ems/api';
/** How long one health request may take — a probe runs every 15 s and must not pile up. */
const EMS_TIMEOUT_MS = 5000;

/** EMS's `health.gpu`, in its own field names. Anything else in the body is not read here. */
type EmsHealthGpu = { util_pct?: unknown; mem_used_mb?: unknown; mem_total_mb?: unknown; temp_c?: unknown };

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The whole-card fields of an EMS health answer as a sample, or undefined when any is missing. */
export const gpuSampleFromHealth = (body: unknown): GpuSample | undefined => {
  const gpu = (body as { gpu?: EmsHealthGpu } | null)?.gpu;
  if (!gpu || typeof gpu !== 'object') return undefined;
  const utilPct = finite(gpu.util_pct);
  const memUsedMb = finite(gpu.mem_used_mb);
  const memTotalMb = finite(gpu.mem_total_mb);
  const tempC = finite(gpu.temp_c);
  if (utilPct === undefined || memUsedMb === undefined || memTotalMb === undefined || tempC === undefined) return undefined;
  return { utilPct, memUsedMb, memTotalMb, tempC };
};

/** One reading, asked of the EMS at `cmd.env.CFG_EMS_URL`. */
export const sampleGpu = async (cmd: SettingsContext): Promise<GpuSample | undefined> => {
  const base = cmd.env.CFG_EMS_URL?.replace(/\/+$/, '');
  if (!base) return undefined;
  try {
    const key = await serviceKey(cmd, 'CFG_EMS_KEY', 'CFG_EMS_URL');
    const response = await fetch(`${base}/v0/health`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
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
