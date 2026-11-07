/**
 * What the media service holds, as one sample of the `ems-models` series (`ems-models-sample`,
 * which the `gpu-sampler` service appends each minute): the card mode, every model copy and where it
 * is, and the families a request is using. Read back by `ems-models` for the Media service tab's
 * strip.
 */

import type { EmsModelsSample, EmsStatus } from './api.ts';

type Running = Extract<EmsStatus, { running: true }>;

/** A reading of core's `pools` series: job counts per pool. */
export type PoolsReading = Record<string, { ready?: number; claimed?: number }>;

/** EiN's work at a pools reading: the intake pool's is not started yet, every other pool's ready jobs are in line. */
export const workWaiting = (pools: PoolsReading, triggerPool: string): { notStarted: number; inLine: number } => {
  let notStarted = 0;
  let inLine = 0;
  for (const [pool, counts] of Object.entries(pools)) {
    if (pool === triggerPool) notStarted += (counts.ready ?? 0) + (counts.claimed ?? 0);
    else inLine += counts.ready ?? 0;
  }
  return { notStarted, inLine };
};

export const modelsSample = (status: Running, waiting?: { notStarted: number; inLine: number }): EmsModelsSample => {
  const working = new Set(status.families.filter((family) => family.running).map((family) => family.name));
  for (const request of status.requests) if (request.started !== undefined && request.family) working.add(request.family);
  // `nvidia-smi` in EMS's container lists only its own processes: the rest of what is used is other containers'.
  const gpu = status.gpu;
  const others = gpu?.processes && gpu.memUsedMb !== undefined ? Math.max(0, gpu.memUsedMb - gpu.processes.reduce((sum, process) => sum + process.usedMb, 0)) : undefined;
  return {
    mode: status.card?.mode ?? 'off',
    copies: status.families.flatMap((family) =>
      family.copies.map((copy) => ({
        family: family.name,
        place: copy.device === 'cuda' ? 'card' as const : 'ram' as const,
        ...(copy.worker ? { worker: copy.worker } : {}),
        state: copy.state,
      }))
    ),
    working: [...working].sort(),
    ...(others !== undefined ? { othersMb: others } : {}),
    ...(waiting ?? {}),
  };
};
