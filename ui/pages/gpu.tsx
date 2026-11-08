import { SimpleGrid, Stack } from '@mantine/core';
import { StatTile, TablerIcon, utilizationColor } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { formatBytes } from '@ein/ui/lib';
import type { EmsGpu, EmsMemory } from '@ems/api';

const pct = (value?: number) => value === undefined ? '—' : `${Math.round(value)}%`;
const mb = (value: number) => formatBytes(value * 1024 * 1024);

/** The load and memory tiles of one instance's card, named `<label> GPU` and `<label> VRAM`. */
function GpuTiles({ gpu, label }: { gpu: NonNullable<EmsGpu>; label: string }) {
  return (
    <>
      <StatTile
        label={`${label} GPU`}
        value={pct(gpu.utilPct)}
        accent={utilizationColor(gpu.utilPct)}
        icon={<TablerIcon name='cpu-2' size={14} />}
        hint={[
          `${gpu.tempC}°C`,
          ...(gpu.powerW !== undefined ? [`${Math.round(gpu.powerW)}${gpu.powerLimitW ? `/${Math.round(gpu.powerLimitW)}` : ''} W`] : []),
          ...(gpu.decPct !== undefined ? [`decode ${pct(gpu.decPct)}`] : []),
          ...(gpu.encPct ? [`encode ${pct(gpu.encPct)}`] : []),
        ].join(' · ')}
        tooltip="Compute load on the media service's card over the seconds before each reading; video decoding and encoding run on units of their own"
        series={gpu.utilSeries}
      />
      <StatTile
        label={`${label} VRAM`}
        value={pct(gpu.vramPercent)}
        accent={utilizationColor(gpu.vramPercent)}
        icon={<TablerIcon name='device-desktop-analytics' size={14} />}
        hint={`${gpu.memUsedMb.toLocaleString()} of ${gpu.memTotalMb.toLocaleString()} MB`}
        tooltip="Memory in use on the media service's card, the chat model's too when it shares the card"
        series={gpu.vramSeries}
      />
    </>
  );
}

/** Another instance's card, under its name; nothing when it has no reading. */
function OtherGpu({ name }: { name: string }) {
  const { data: gpu } = usePolledCommand<EmsGpu>(`ems-gpu --instance ${name}`);
  if (!gpu) return null;
  return (
    <SimpleGrid cols={2} spacing='sm'>
      <GpuTiles gpu={gpu} label={name} />
    </SimpleGrid>
  );
}

/**
 * The media service on the system dashboard's overview, beside the host's CPU and memory (`ems.gpu`,
 * a `system.overview` panel in ems's `nav.json`): its card's load and memory (`ems-gpu`) and its
 * machine's RAM (`ems-memory`), each tile named as the media service's, since that may be another
 * machine than EiN's, then each other instance's card under its name (`ems-instance list`). A tile
 * is left out when there is no reading — no GPU and an idle GPU are not the same fact.
 */
export default function MediaServicePanel() {
  const { data: gpu } = usePolledCommand<EmsGpu>('ems-gpu');
  const { data: memory } = usePolledCommand<EmsMemory>('ems-memory');
  const { data: others } = usePolledCommand<string[]>('ems-instance list --others --names');
  const tiles = (gpu ? 2 : 0) + (memory ? 1 : 0);
  if (tiles === 0 && !others?.length) return null;

  return (
    <Stack gap='sm'>
      {tiles > 0 && (
        <SimpleGrid cols={tiles} spacing='sm'>
          {gpu && <GpuTiles gpu={gpu} label='EMS' />}
          {memory && (
            <StatTile
              label='EMS RAM'
              value={pct(memory.percent)}
              accent={utilizationColor(memory.percent)}
              icon={<TablerIcon name='device-sd-card' size={14} />}
              hint={`${mb(memory.usedMb)} of ${mb(memory.totalMb)}${memory.emsMb !== undefined ? ` · EMS ${pct((memory.emsMb / memory.totalMb) * 100)}` : ''}`}
              tooltip={`The memory of the machine the media service runs on${
                memory.emsMb !== undefined
                  ? `; EMS is its own container's part of it, ${mb(memory.emsMb)}${memory.emsLimitMb !== undefined ? ` of the ${mb(memory.emsLimitMb)} it may hold` : ''}`
                  : ''
              }`}
              series={memory.series}
            />
          )}
        </SimpleGrid>
      )}
      {(others ?? []).map((name) => <OtherGpu key={name} name={name} />)}
    </Stack>
  );
}
