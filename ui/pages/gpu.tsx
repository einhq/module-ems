import { SimpleGrid } from '@mantine/core';
import { StatTile, TablerIcon, utilizationColor } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import type { EmsGpu } from '@ems/api';

const pct = (value?: number) => value === undefined ? '—' : `${Math.round(value)}%`;

/**
 * The media service's card on the system dashboard's overview, beside the host's CPU and memory
 * (`ems.gpu`, a `system.overview` panel in ems's `nav.json`): `ems-gpu`, polled while shown.
 * Nothing at all when there is no reading — no GPU and an idle GPU are not the same fact.
 */
export default function GpuPanel() {
  const { data: gpu } = usePolledCommand<EmsGpu>('ems-gpu');
  if (!gpu) return null;

  return (
    <SimpleGrid cols={2} spacing='sm'>
      <StatTile
        label='GPU'
        value={pct(gpu.utilPct)}
        accent={utilizationColor(gpu.utilPct)}
        icon={<TablerIcon name='cpu-2' size={14} />}
        hint={`${gpu.tempC}°C`}
        tooltip="Utilization of the media service's card"
        series={gpu.utilSeries}
      />
      <StatTile
        label='VRAM'
        value={pct(gpu.vramPercent)}
        accent={utilizationColor(gpu.vramPercent)}
        icon={<TablerIcon name='device-desktop-analytics' size={14} />}
        hint={`${gpu.memUsedMb.toLocaleString()} of ${gpu.memTotalMb.toLocaleString()} MB`}
        tooltip="Memory in use on the media service's card"
        series={gpu.vramSeries}
      />
    </SimpleGrid>
  );
}
