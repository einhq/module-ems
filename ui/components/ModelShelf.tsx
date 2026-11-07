import { Box, Card, Group, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { TablerIcon, WORKLOAD_COLORS } from '@ein/ui/components';
import type { EmsFamily, EmsStatus } from '@ems/api';
import { type Holding, holdingsOf, type Shelf, shelfOf, size } from './holdings.ts';

type Running = Extract<EmsStatus, { running: true }>;

const SHELVES: { shelf: Shelf; title: string; empty: string }[] = [
  { shelf: 'working', title: 'Working', empty: 'Nothing is being worked on' },
  { shelf: 'loaded', title: 'Loaded, idle', empty: 'None' },
  { shelf: 'loading', title: 'Loading or unloading', empty: 'None' },
  { shelf: 'unloaded', title: 'Not loaded', empty: 'None' },
];

/** Where a family's copies are: `GPU 2.8 GB + RAM 1.7 GB standby`. */
const where = (copies: Holding[]): string =>
  copies.map((copy) => `${copy.place === 'card' ? 'GPU' : 'RAM'} ${size(copy.mb)}${copy.standby ? ' standby' : copy.state !== 'loaded' ? ` ${copy.state}` : ''}`).join(' + ');

/**
 * Every model the media service can load, on the shelf for what it is doing: working, loaded and
 * idle, loading or unloading, not loaded — so which models are loaded right now is the first thing
 * read, and where each is. The per-family detail is the table under it.
 */
export function ModelShelf({ status }: { status: Running }) {
  const holdings = holdingsOf(status);
  const byFamily = new Map<string, Holding[]>(status.families.map((family) => [family.name, holdings.filter((holding) => holding.family === family.name)]));
  const purpose = new Map<string, EmsFamily>(status.families.map((family) => [family.name, family]));
  const shelved = new Map<Shelf, string[]>(SHELVES.map(({ shelf }) => [shelf, []]));
  for (const [family, copies] of byFamily) shelved.get(shelfOf(copies))!.push(family);
  const loaded = status.families.length - shelved.get('unloaded')!.length;

  return (
    <Card>
      <Group gap='xs' mb='sm'>
        <TablerIcon name='cpu' size={18} />
        <Title order={5}>Models</Title>
        <Text size='sm' c='dimmed' ml='auto'>{loaded} of {status.families.length} loaded</Text>
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing='sm' style={{ alignItems: 'start' }}>
        {SHELVES.map(({ shelf, title, empty }) => {
          const families = shelved.get(shelf)!.sort();
          return (
            <Stack key={shelf} gap={6} p={8} style={{ borderRadius: 8, background: 'var(--mrx-surface-overlay)', alignContent: 'start' }}>
              <Group gap='xs'>
                <Text size='sm' fw={600}>{title}</Text>
                <Text size='sm' c='dimmed' ml='auto'>{families.length}</Text>
              </Group>
              {families.length === 0 && <Text size='xs' c='dimmed'>{empty}</Text>}
              {families.map((family) => {
                const copies = byFamily.get(family)!;
                return (
                  <Tooltip key={family} label={purpose.get(family)?.purpose ?? family} withArrow multiline maw={320} disabled={!purpose.get(family)?.purpose}>
                    {/* Where it is under its name, so a long one (two copies, standby) never cuts the name short. */}
                    <Stack gap={0} px={8} py={4} style={{ borderRadius: 6, background: 'var(--mrx-surface-raised)' }}>
                      <Group gap={6} wrap='nowrap'>
                        {copies.some((copy) => copy.working) && <Box w={7} h={7} style={{ borderRadius: '50%', background: WORKLOAD_COLORS.running, flexShrink: 0 }} />}
                        <Text size='sm' ff='monospace' truncate>{family}</Text>
                      </Group>
                      {copies.length > 0 && <Text size='xs' c='dimmed'>{where(copies)}</Text>}
                    </Stack>
                  </Tooltip>
                );
              })}
            </Stack>
          );
        })}
      </SimpleGrid>
    </Card>
  );
}
