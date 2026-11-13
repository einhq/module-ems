import { Box, Card, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { TablerIcon } from '@ein/ui/components';
import type { EmsStatus } from '@ems/api';
import { CardShare } from './CardShare.tsx';
import { CARD_COLOR, holdingsOf, RAM_COLOR, size } from './holdings.ts';

type Running = Extract<EmsStatus, { running: true }>;

type Segment = { label: string; mb: number; color: string; note: string; hatched?: boolean };

const CHAT_COLOR = 'var(--mantine-color-grape-6)';
const RUNTIME_COLOR = 'var(--mantine-color-teal-9)';
const WORKER_COLOR = 'var(--mantine-color-blue-9)';
const FREE_COLOR = 'var(--mrx-surface-overlay)';

/** The primary instance's name: its share of the card is EiN's setting, another's is its own. */
const PRIMARY = 'main';

/** A bar of what holds a memory, each part labelled inside it where it fits and in its tooltip. */
function Bar({ segments, total }: { segments: Segment[]; total: number }) {
  return (
    <Group gap={2} wrap='nowrap' h={32} style={{ borderRadius: 6, overflow: 'hidden', background: FREE_COLOR }}>
      {segments.filter((segment) => segment.mb > 0).map((segment) => (
        <Tooltip key={segment.label} label={`${segment.label}: ${size(segment.mb)} — ${segment.note}`} withArrow multiline maw={320}>
          <Box
            h='100%'
            px={6}
            style={{
              flex: `0 0 ${(segment.mb / total) * 100}%`,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              color: segment.color === FREE_COLOR ? 'var(--mrx-text-tertiary)' : 'white',
              background: segment.hatched
                ? `repeating-linear-gradient(135deg, ${segment.color} 0 6px, color-mix(in srgb, ${segment.color} 55%, transparent) 6px 12px)`
                : segment.color,
            }}
          >
            <Text size='xs' truncate>{segment.label} {size(segment.mb)}</Text>
          </Box>
        </Tooltip>
      ))}
    </Group>
  );
}

/**
 * Where the media service's models are, as two bars: the graphics card, split into each model on
 * it, EMS's own runtime there, the chat model and whatever else shares the card, and what is free;
 * and EMS's RAM, split into each model held there and its workers' own memory. A search model kept
 * in RAM while its card copy answers is hatched, as standby: it is what answers the moment indexing
 * takes the card, so search never stops (ein/core#1070). Under the card's bar, the primary's share
 * of it, which a slider sets (`CardShare`), where EMS can change it.
 */
export function MemoryMap({ status }: { status: Running }) {
  const holdings = holdingsOf(status).filter((holding) => holding.mb !== undefined && holding.mb > 0);
  const gpu = status.gpu;
  const processes = gpu?.processes ?? [];
  const ems = processes.reduce((sum, process) => sum + process.usedMb, 0);
  const onCard = holdings.filter((holding) => holding.place === 'card');
  const modelsOnCard = onCard.reduce((sum, holding) => sum + holding.mb!, 0);
  const used = gpu?.memUsedMb;
  const total = gpu?.memTotalMb;

  const card: Segment[] = total && used !== undefined
    ? [
      ...onCard.map((holding) => ({
        label: holding.family,
        mb: holding.mb!,
        color: CARD_COLOR,
        note: holding.search ? 'a search model on the card, while no indexing work holds it' : 'an indexing model',
      })),
      {
        label: 'EMS runtime',
        mb: Math.max(0, ems - modelsOnCard),
        color: RUNTIME_COLOR,
        note: "EMS's processes beyond their models: CUDA contexts, buffers, transcodes",
      },
      {
        label: 'chat model and others',
        mb: gpu?.processes ? Math.max(0, used - ems) : 0,
        color: CHAT_COLOR,
        note: "what other containers hold of the card; in a standard install, the assistant's chat model",
      },
      { label: 'free', mb: Math.max(0, total - used), color: FREE_COLOR, note: 'nothing holds it' },
    ]
    : [];

  const inRam = holdings.filter((holding) => holding.place === 'ram');
  const workerRest = (worker: string, rss?: number) =>
    rss === undefined ? 0 : Math.max(0, rss - inRam.filter((holding) => holding.worker === worker).reduce((sum, holding) => sum + holding.mb!, 0));
  const ram: Segment[] = [
    ...inRam.map((holding) => ({
      label: holding.family,
      mb: holding.mb!,
      color: RAM_COLOR,
      hatched: holding.standby,
      note: holding.standby
        ? 'standby: a search model kept in RAM while its card copy answers, so search goes on the moment indexing takes the card'
        : holding.search
        ? 'a search model, answering on the CPU while indexing has the card'
        : 'an indexing model running on the CPU',
    })),
    {
      label: 'batch worker',
      mb: workerRest('batch', status.rssMb),
      color: WORKER_COLOR,
      note: 'the indexing worker beyond its models: the files it decodes, and every model passes through here while it loads',
    },
    { label: 'query worker', mb: workerRest('query', status.queryWorker?.rssMb), color: WORKER_COLOR, note: "the search worker's own runtime" },
  ];
  const ramTotal = ram.reduce((sum, segment) => sum + segment.mb, 0);
  const standby = inRam.filter((holding) => holding.standby);
  // Each worker rebuilds itself at its ceiling; a count of rebuilds that keeps climbing is a leak.
  const rebuilt = (n?: number) => (n ? `, rebuilt ${n} time${n === 1 ? '' : 's'} so far` : '');
  const ceilings = [
    status.maxRssMb ? `the batch worker rebuilds itself at ${size(status.maxRssMb)}${rebuilt(status.recycles)}` : '',
    status.queryWorker?.maxRssMb ? `the query worker at ${size(status.queryWorker.maxRssMb)}${rebuilt(status.queryWorker.recycles)}` : '',
  ].filter(Boolean);

  return (
    <Card>
      <Group gap='xs' mb='sm'>
        <TablerIcon name='stack-2' size={18} />
        <Title order={5}>Where the models are</Title>
      </Group>
      <Stack gap='md'>
        <Stack gap={6}>
          <Group gap='xs'>
            <Text size='sm' fw={600}>Graphics card</Text>
            {used !== undefined && total && <Text size='sm' c='dimmed' ml='auto'>{size(used)} of {size(total)}</Text>}
          </Group>
          {card.length > 0
            ? <Bar segments={card} total={total!} />
            : <Text size='sm' c='dimmed'>{gpu?.present ? 'The card does not report its memory.' : 'No graphics card.'}</Text>}
          {card.length > 0 && status.card?.shareMb !== undefined && (status.instance ?? PRIMARY) === PRIMARY && <CardShare status={status} total={total!} />}
        </Stack>
        <Stack gap={6}>
          <Group gap='xs'>
            <Text size='sm' fw={600}>RAM</Text>
            <Text size='sm' c='dimmed' ml='auto'>{size(ramTotal)} held</Text>
          </Group>
          {ramTotal > 0 ? <Bar segments={ram} total={ramTotal} /> : <Text size='sm' c='dimmed'>No model in RAM.</Text>}
        </Stack>
        <Group gap='lg' wrap='wrap'>
          {[
            { label: 'model on the card', color: CARD_COLOR },
            { label: 'model in RAM', color: RAM_COLOR },
            { label: 'standby', color: RAM_COLOR, hatched: true },
            { label: 'EMS runtime', color: RUNTIME_COLOR },
            { label: 'chat model and others', color: CHAT_COLOR },
            { label: 'free', color: FREE_COLOR },
          ].map((entry) => (
            <Group key={entry.label} gap={6} wrap='nowrap'>
              <Box
                w={10}
                h={10}
                style={{
                  borderRadius: 2,
                  background: entry.hatched
                    ? `repeating-linear-gradient(135deg, ${entry.color} 0 3px, color-mix(in srgb, ${entry.color} 45%, transparent) 3px 6px)`
                    : entry.color,
                  border: entry.color === FREE_COLOR ? '1px solid var(--mrx-hairline)' : undefined,
                }}
              />
              <Text size='xs'>{entry.label}</Text>
            </Group>
          ))}
        </Group>
        {standby.length > 0 && (
          <Text size='xs' c='dimmed'>
            {standby.map((holding) => holding.family).join(' and ')} are on the card and also in RAM,{' '}
            {size(standby.reduce((sum, holding) => sum + holding.mb!, 0))}: the card answers the searches now, and the RAM copies answer the moment indexing takes the card, so
            search never stops.
          </Text>
        )}
        {ceilings.length > 0 && <Text size='xs' c='dimmed'>In RAM, {ceilings.join(' and ')}.</Text>}
      </Stack>
    </Card>
  );
}
