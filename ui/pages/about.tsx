import { Skeleton } from '@mantine/core';
import { StatTile } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import { formatUptime } from '@ein/ui/lib';
import type { EmsStatus } from '@ems/api';

/**
 * The media service on the About dialog (`ems.about`, an `about.services` panel in ems's `nav.json`),
 * from `ems-status`: EMS's version, the API it speaks, its commit, how long it has been up and the
 * card it runs on.
 */
export default function MediaServiceAbout() {
  const { data, error } = usePolledCommand<EmsStatus>('ems-status');
  if (!data && !error) return <Skeleton height={86} radius='md' />;
  if (!data?.running) return <StatTile label='Media service' value='Not answering' hint={data?.url} accent='#e66767' />;

  const facts = [
    `API ${data.api}`,
    data.build?.commit,
    `up ${formatUptime(data.uptime * 1000)}`,
    data.gpu?.name ? `on ${data.gpu.name}` : 'no graphics card',
  ];
  return (
    <StatTile
      label='Media service'
      value={data.build?.version ?? data.api}
      hint={facts.filter(Boolean).join(', ')}
      accent='#22b8cf'
      tooltip={data.gpu?.driver ? `${data.url}, driver ${data.gpu.driver}` : data.url}
    />
  );
}
