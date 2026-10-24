import { usePolledCommand } from '@ein/ui/hooks';
import type { EmsStatus } from '@ems/api';
import { MediaService } from '../components/MediaService.tsx';

/**
 * What the media service holds and is doing (`ems-status`, polled while shown): the system
 * dashboard's Media service tab (`ems.media-service`, a `system.tabs` panel in ems's `nav.json`).
 * EMS not answering is this page's whole message, said here rather than in the dashboard's alert.
 */
export default function MediaServicePage() {
  const { data, error } = usePolledCommand<EmsStatus>('ems-status');
  return <MediaService status={data ?? undefined} error={error} />;
}
