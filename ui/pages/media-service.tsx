import { useState } from 'react';
import { Badge, Box, Group, Paper, ScrollArea, Select, Stack, Text, UnstyledButton } from '@mantine/core';
import { usePolledCommand } from '@ein/ui/hooks';
import type { EmsInstanceRow, EmsModels, EmsStatus } from '@ems/api';
import { MediaService } from '../components/MediaService.tsx';

const PRIMARY = 'main';

/** `--instance <name>` for another instance, nothing for the primary. */
const of = (name: string) => name === PRIMARY ? '' : ` --instance ${name}`;

/** What one instance holds and is doing; keyed by its name, so a switch starts from nothing. */
function InstanceView({ name }: { name: string }) {
  const { data, error } = usePolledCommand<EmsStatus>(`ems-status${of(name)}`);
  const { data: history } = usePolledCommand<EmsModels>(`ems-models${of(name)}`);
  return <MediaService status={data ?? undefined} error={error} history={history} />;
}

/** An instance's card in a phrase: its name, or that it has none. */
const cardOf = (row: EmsInstanceRow): string => row.gpu?.present ? row.gpu.name ?? 'a card' : 'CPU only';

/** One instance in the list: its name, up or down, its card, and for another the ops it serves. */
function InstanceRow({ row, chosen, onChoose }: { row: EmsInstanceRow; chosen: boolean; onChoose: () => void }) {
  return (
    <UnstyledButton
      onClick={onChoose}
      style={{ padding: '8px 10px', borderRadius: 'var(--mantine-radius-sm)', background: chosen ? 'var(--mrx-surface-raised)' : undefined }}
    >
      <Group gap='xs' wrap='nowrap'>
        <Text size='sm' fw={chosen ? 600 : 400} style={{ flex: 1 }} truncate>{row.name}{row.primary ? ' (primary)' : ''}</Text>
        <Badge size='xs' variant='light' color={row.answering ? 'teal' : 'red'}>{row.answering ? 'up' : 'down'}</Badge>
      </Group>
      <Text size='xs' c='dimmed' truncate>{row.answering ? cardOf(row) : row.url}</Text>
      {!row.primary && row.ops && <Text size='xs' c='dimmed' lineClamp={2} ff='monospace'>{row.ops.length ? row.ops.join(' ') : 'serves nothing'}</Text>}
    </UnstyledButton>
  );
}

/**
 * What the media service holds and is doing (`ems-status`, polled while shown): the system
 * dashboard's Media service tab (`ems.media-service`, a `system.tabs` panel in ems's `nav.json`).
 * EMS not answering is this page's whole message, said here rather than in the dashboard's alert.
 *
 * With instances beside the primary (`ems-instance list`), a list of them stands beside it, as the
 * chat page's chats do, and on a phone a menu above it: each up or down, its card or "CPU only",
 * and the ops another serves. The one chosen is shown.
 */
export default function MediaServicePage() {
  const { data: instances } = usePolledCommand<EmsInstanceRow[]>('ems-instance list');
  const [chosen, setChosen] = useState(PRIMARY);
  const name = instances?.some((row) => row.name === chosen) ? chosen : PRIMARY;
  const view = <InstanceView key={name} name={name} />;
  if (!instances || instances.length < 2) return view;

  return (
    <Box style={{ display: 'flex', gap: 'var(--mantine-spacing-md)', alignItems: 'flex-start' }}>
      <Box w={260} style={{ flex: '0 0 260px', position: 'sticky', top: 0 }} visibleFrom='sm'>
        <Paper p='sm' radius='md' withBorder>
          <ScrollArea.Autosize mah='70dvh' type='auto' scrollbars='y' offsetScrollbars='y'>
            <Stack gap={2}>
              {instances.map((row) => <InstanceRow key={row.name} row={row} chosen={row.name === name} onChoose={() => setChosen(row.name)} />)}
            </Stack>
          </ScrollArea.Autosize>
        </Paper>
      </Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Select
          hiddenFrom='sm'
          mb='sm'
          aria-label='Instance'
          value={name}
          onChange={(value) => value && setChosen(value)}
          allowDeselect={false}
          data={instances.map((row) => ({ value: row.name, label: `${row.name} · ${row.answering ? cardOf(row) : 'down'}` }))}
        />
        {view}
      </Box>
    </Box>
  );
}
