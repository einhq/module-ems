import { Alert, Badge, Box, Button, Card, Collapse, Group, HoverCard, Loader, Progress, SimpleGrid, Skeleton, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import type { EmsCaller, EmsCardMode, EmsFamily, EmsLane, EmsModelCopy, EmsModels, EmsModelSize, EmsPlacement, EmsRequest, EmsStatus } from '@ems/api';
import { TablerIcon, utilizationColor } from '@ein/ui/components';
import { formatUptime } from '@ein/ui/lib';
import { useState } from 'react';
import { MemoryMap } from './MemoryMap.tsx';
import { ModelShelf } from './ModelShelf.tsx';
import { ModelTimeline } from './ModelTimeline.tsx';

type Props = {
  /** Absent until the first answer arrives. */
  status?: EmsStatus;
  /** `ems-status` exits non-zero when EMS is not answering, so that arrives as an error. */
  error?: Error | null;
  /** `ems-models`: what it held over the last hours, for the strip; null until it is in. */
  history?: EmsModels | null;
};

type Running = Extract<EmsStatus, { running: true }>;

/** Epoch seconds from EMS, as an age next to now — in seconds while short, since a load is watched by the second. */
const ago = (epochSeconds?: number): string | undefined => {
  if (epochSeconds === undefined) return undefined;
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  return seconds < 60 ? `${Math.round(seconds)}s` : formatUptime(seconds * 1000);
};

const clock = (epochSeconds: number): string => new Date(epochSeconds * 1000).toLocaleString();

const megabytes = (mb?: number): string => mb === undefined ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;

const deviceName = (device?: string): string => device === 'cuda' ? 'GPU' : device === 'cpu' ? 'CPU' : '';

/**
 * What a copy is doing, in the words a person uses: "GPU loaded", "CPU loading", "GPU unloading".
 * The device leads because it is the costly half — `faces` moved onto the CPU after the card
 * ran out is resident and several times slower, which "loaded" alone would hide.
 */
const copyLabel = (copy: EmsModelCopy): string => [deviceName(copy.device), copy.state].filter(Boolean).join(' ');

const copyColor = (copy: EmsModelCopy): string => {
  if (copy.state === 'loading') return 'yellow';
  if (copy.state === 'unloading') return 'orange';
  return copy.device === 'cpu' ? 'blue' : 'teal';
};

/**
 * What each admission lane is, for someone who has never read EMS's source. The lanes are EMS's
 * own queues in front of its work: the limit is how many requests of that kind it runs at once.
 */
const LANES: Record<string, string> = {
  models:
    'Requests for a model. EMS admits up to the limit at once, but each model runs one request at a time — an admitted request may still be waiting for its model, which the Models table counts as waiting.',
  tools: 'Work EMS does itself on the CPU: reading metadata (exiftool, ffprobe), thumbnails and renditions, audio fingerprints, text from documents, video frames.',
  encodes: 'Video and audio transcodes. Kept in a lane of their own because one holds its slot for minutes and would otherwise sit ahead of every quick request.',
};

/**
 * Busy and changing first, then what holds memory, then the rest by name: the rows that move are
 * the ones anyone opens this to see, and a family loading below a dozen idle ones would be
 * the same silence as not showing it.
 */
const rank = (family: EmsFamily): number => {
  if (family.copies.some((copy) => copy.state !== 'loaded')) return 0;
  if (family.running || family.waiting > 0) return 1;
  if (family.copies.some((copy) => copy.device === 'cuda')) return 2;
  if (family.copies.length > 0) return 3;
  return 4;
};

/** One fact and its label, as the instance footer draws them. */
function Fact({ label, value, tooltip }: { label: string; value: string; tooltip?: string }) {
  const body = (
    <Group gap={6} wrap='nowrap'>
      <Text size='xs' c='dimmed'>{label}</Text>
      <Text size='xs' ff='monospace'>{value}</Text>
    </Group>
  );
  return tooltip ? <Tooltip label={tooltip} withArrow multiline maw={320}>{body}</Tooltip> : body;
}

/**
 * The media service: what it is, whether it is well, which models it holds and where, and what it
 * is doing right now.
 *
 * Every model EMS can load gets a row, loaded or not — "whisper is not loaded" is an answer, and
 * the question it answers ("why is the first transcription slow?") is the one that brings someone
 * here. A row's status is per copy, because a family can sit on the card and on the CPU at once
 * after the card filled.
 */
export function MediaService({ status, error, history }: Props) {
  if (!status && error) {
    return (
      <Alert color='red' variant='light' icon={<TablerIcon name='plug-connected-x' size={16} />} title='The media service is not answering'>
        {error.message}
      </Alert>
    );
  }
  if (!status) {
    return (
      <Stack gap='lg'>
        <Skeleton height={96} />
        <Skeleton height={320} />
      </Stack>
    );
  }
  if (!status.running) {
    return (
      <Alert color='red' variant='light' icon={<TablerIcon name='plug-connected-x' size={16} />} title='The media service is not answering'>
        Nothing answers at <Text span ff='monospace'>{status.url}</Text>.
      </Alert>
    );
  }

  const families = status.families;
  return (
    <Stack gap='lg'>
      <Summary status={status} />
      {status.degraded.map((d) => (
        <Alert key={`${d.what}-${d.reason}`} color='orange' variant='light' icon={<TablerIcon name='alert-triangle' size={16} />} title={`${d.what} degraded`}>
          {d.reason}
          {d.since !== undefined && ` — for ${ago(d.since)}`}
        </Alert>
      ))}
      {(status.warnings ?? []).map((warning) => <Alert key={warning} color='yellow' variant='light' icon={<TablerIcon name='alert-triangle' size={16} />}>{warning}</Alert>)}
      <MemoryMap status={status} />
      <ModelShelf status={status} />
      <ModelTimeline history={history} />
      <ModelDetails families={families} mode={status.card?.mode} />
      <Requests requests={status.requests} queues={status.queues} callers={status.callers} families={families} />
    </Stack>
  );
}

function Summary({ status }: { status: Running }) {
  const { gpu, worker } = status;
  const health = !worker.running
    ? { label: 'model worker down', color: 'red' }
    : status.degraded.length > 0
    ? { label: 'degraded', color: 'orange' }
    : { label: 'healthy', color: 'teal' };
  const build = status.build;
  const workerState = (w: { running: boolean; restarts: number }) => `${w.running ? 'up' : 'down'}${w.restarts ? ` ×${w.restarts}` : ''}`;

  return (
    <Card>
      <Group gap='xs' mb='xs'>
        <TablerIcon name='server-2' size={18} />
        <Title order={4}>Media service</Title>
        <Badge variant='light' color={health.color} ml='auto'>{health.label}</Badge>
      </Group>
      <Group gap='xl' wrap='wrap'>
        {build?.version && <Fact label='version' value={build.version} />}
        {build?.commit && <Fact label='commit' value={build.commit} tooltip={build.date ? `Committed ${new Date(build.date).toLocaleString()}` : undefined} />}
        <Fact label='api' value={status.api} />
        <Fact label='uptime' value={formatUptime(status.uptime * 1000)} />
        <Fact
          label='batch worker'
          value={workerState(worker)}
          tooltip='The model process for indexing work: faces, speech and voices, text in pictures and handwriting, picture and text vectors, copy detection.'
        />
        {worker.query && (
          <Fact
            label='query worker'
            value={workerState(worker.query)}
            tooltip='A second model process that only answers search queries, on the CPU, so a search never waits behind indexing.'
          />
        )}
        {gpu?.name && <Fact label='card' value={gpu.name} />}
        {gpu?.driver && <Fact label='driver' value={gpu.driver} />}
        <Fact label='url' value={status.url} />
      </Group>
      {status.card && status.card.mode !== 'off' && <CardMode card={status.card} />}
    </Card>
  );
}

/** What each card mode means, for the badge and the line under it. */
const MODES: Record<EmsCardMode, { label: string; color: string; says: string }> = {
  busy: {
    label: 'busy',
    color: 'orange',
    says: 'Indexing has the graphics card and search runs on the CPU, until no indexing work has come for a while.',
  },
  quiet: {
    label: 'quiet',
    color: 'teal',
    says: 'No indexing work, so its models are unloaded and search runs on the graphics card, as far as it fits.',
  },
  switching: { label: 'switching', color: 'blue', says: 'Handing the graphics card over between indexing and search.' },
  off: { label: 'off', color: 'gray', says: 'No graphics card to share: every model runs where its setting says.' },
};

const minutes = (seconds: number): string => seconds < 90 ? `${Math.max(0, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;

/** Who has the graphics card now, and when that changes: a part of the Media service box. */
function CardMode({ card }: { card: NonNullable<Running['card']> }) {
  const mode = MODES[card.mode];
  const quietIn = card.mode === 'busy' && card.lastBatch !== undefined && card.quietAfter !== undefined ? card.lastBatch + card.quietAfter - Date.now() / 1000 : undefined;
  return (
    <Stack gap={6} mt='md' pt='sm' style={{ borderTop: '1px solid var(--mrx-hairline)' }}>
      <Group gap='xs' wrap='nowrap'>
        <TablerIcon name='arrows-exchange' size={16} />
        <Text size='sm' fw={600}>Graphics card</Text>
        <Badge variant='light' color={mode.color}>{mode.label}</Badge>
        <Text size='sm' c='dimmed'>{mode.says}</Text>
      </Group>
      <Group gap='xl' wrap='wrap'>
        {card.since !== undefined && <Fact label='since' value={`${ago(card.since)} ago`} tooltip={clock(card.since)} />}
        {card.mode === 'busy' && (
          <Fact
            label='quiet'
            value={card.batchInFlight ? 'not while indexing runs' : quietIn !== undefined ? `in ${minutes(quietIn)}` : '—'}
            tooltip={card.quietAfter !== undefined ? `After ${minutes(card.quietAfter)} without indexing work.` : undefined}
          />
        )}
        {card.mode === 'quiet' && (
          <Fact
            label='search on the GPU'
            value={card.searchOnCard.length > 0 ? card.searchOnCard.join(', ') : 'nothing fits'}
            tooltip='Busy again as soon as indexing work arrives: it waits until search has left the card.'
          />
        )}
        {card.quietAfter !== undefined && <Fact label='quiet after' value={minutes(card.quietAfter)} tooltip='How long without indexing work before search gets the card.' />}
      </Group>
    </Stack>
  );
}

const PLACEMENTS: Record<EmsPlacement, { label: string; color: string }> = {
  card: { label: 'GPU', color: 'teal' },
  cpu: { label: 'CPU', color: 'blue' },
  unloaded: { label: 'unloaded', color: 'gray' },
};

function Placement({ placement, why }: { placement: EmsPlacement; why?: string }) {
  const { label, color } = PLACEMENTS[placement];
  const badge = <Badge size='sm' variant={placement === 'unloaded' ? 'outline' : 'light'} color={color}>{label}</Badge>;
  return why ? <Tooltip label={why} withArrow>{badge}</Tooltip> : badge;
}

/**
 * Where the card's memory and the workers' RAM go.
 *
 * The card's figure and the models' never agree, and the reason is not one thing: `nvidia-smi`
 * counts every process on the card, other containers' included (in production the chat model's server
 * holds most of it), while EMS can only name its own processes; and inside the batch worker's
 * share, torch counts only torch's tensors — the CUDA context and onnxruntime's arenas (the face
 * models) are invisible to it. So the bar splits the card by process, and torch's number is the
 * detail under the worker's segment.
 */
/** The model's name, with what it is for on hover — nobody remembers what "asd" is. */
function FamilyName({ family }: { family: EmsFamily }) {
  const name = (
    <Group gap={6} wrap='nowrap'>
      <Text size='sm' ff='monospace' style={{ cursor: family.purpose ? 'help' : undefined }}>{family.name}</Text>
      {family.purpose && <TablerIcon name='info-circle' size={13} style={{ opacity: 0.5 }} />}
      {family.pinned && (
        <Tooltip label='Pinned: loaded at start and never unloaded, because search waits on it' withArrow>
          <TablerIcon name='pin' size={13} />
        </Tooltip>
      )}
    </Group>
  );
  return (
    <Stack gap={0}>
      {family.purpose
        ? (
          <HoverCard width={340} shadow='md' withArrow openDelay={150} position='right'>
            <HoverCard.Target>{name}</HoverCard.Target>
            <HoverCard.Dropdown>
              <Stack gap='xs'>
                <Text size='sm' fw={600} ff='monospace'>{family.name}</Text>
                <Text size='sm'>{family.purpose}</Text>
                {family.model && (
                  <Text size='xs' c='dimmed'>
                    Model <Text span ff='monospace' size='xs'>{family.model}</Text>
                  </Text>
                )}
                {family.ops && family.ops.length > 0 && (
                  <Group gap={4}>
                    <Text size='xs' c='dimmed'>Used by</Text>
                    {family.ops.map((op) => <Badge key={op} size='xs' variant='outline' tt='none'>{op}</Badge>)}
                  </Group>
                )}
                {family.device && (
                  <Text size='xs' c='dimmed'>
                    Configured device <Text span ff='monospace' size='xs'>{family.device}</Text>
                    {family.device === 'auto' && ' — the GPU when it has room, the CPU otherwise'}
                  </Text>
                )}
                {family.pinned && <Text size='xs' c='dimmed'>Pinned: loaded at start and never unloaded.</Text>}
              </Stack>
            </HoverCard.Dropdown>
          </HoverCard>
        )
        : name}
      {family.model && <Text size='xs' c='dimmed'>{family.model}</Text>}
    </Stack>
  );
}

/** VRAM and RAM a load cost, compact; `last` dims it as a figure from a load that is gone. */
function Size({ size, last }: { size?: EmsModelSize; last?: boolean }) {
  if (!size || (size.vramMb === undefined && size.ramMb === undefined)) return <Text size='xs' c='dimmed'>—</Text>;
  const parts = [size.vramMb ? `${megabytes(size.vramMb)} VRAM` : '', size.ramMb ? `${megabytes(size.ramMb)} RAM` : ''].filter(Boolean);
  const label = [
    'Measured when it loaded: free card memory and worker RAM before and after, so approximate when other work ran beside it.',
    size.loadSeconds !== undefined ? `The load took ${size.loadSeconds < 60 ? `${size.loadSeconds}s` : formatUptime(size.loadSeconds * 1000)}.` : '',
    last ? 'Not loaded now — this is from its last load.' : '',
  ].filter(Boolean).join(' ');
  return (
    <Tooltip label={label} withArrow multiline maw={300}>
      <Text size='xs' ff='monospace' c={last ? 'dimmed' : undefined}>{parts.join(' · ') || '< 1 MB'}</Text>
    </Tooltip>
  );
}

/** The per-family table, folded under the shelf: placement in each card mode, sizes, when each was used. */
function ModelDetails({ families, mode }: { families: EmsFamily[]; mode?: EmsCardMode }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap='xs'>
      <Button
        variant='subtle'
        size='xs'
        w='fit-content'
        leftSection={<TablerIcon name={open ? 'chevron-down' : 'chevron-right'} size={14} />}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide the models in detail' : 'Every model in detail: where it runs in each mode, its size, when it was last used'}
      </Button>
      <Collapse expanded={open}>
        <Models families={families} mode={mode} />
      </Collapse>
    </Stack>
  );
}

function Models({ families, mode }: { families: EmsFamily[]; mode?: EmsCardMode }) {
  const planned = families.some((family) => family.plan);
  const header = (label: string, which: EmsCardMode, tooltip: string) => (
    <Table.Th>
      <Tooltip label={tooltip} withArrow multiline maw={300}>
        <Group gap={4} wrap='nowrap'>
          <Text size='sm' fw={600}>{label}</Text>
          {mode === which && <Badge size='xs' variant='filled' color={MODES[which].color}>now</Badge>}
        </Group>
      </Tooltip>
    </Table.Th>
  );
  const rows = [...families].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const onCard = families.filter((family) => family.copies.some((copy) => copy.device === 'cuda' && copy.state !== 'unloading')).length;
  const resident = families.filter((family) => family.copies.length > 0).length;

  return (
    <Card>
      <Group gap='xs' mb='md'>
        <TablerIcon name='cpu' size={18} />
        <Title order={4}>Models</Title>
        <Text size='sm' c='dimmed' ml='auto'>
          {`${resident} of ${families.length} loaded · ${onCard} on the GPU`}
        </Text>
      </Group>
      <Table.ScrollContainer minWidth={planned ? 940 : 760}>
        <Table striped highlightOnHover verticalSpacing='xs'>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Model</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Loaded</Table.Th>
              <Table.Th>Last used</Table.Th>
              <Table.Th>Size</Table.Th>
              <Table.Th>Activity</Table.Th>
              {planned && header('When busy', 'busy', MODES.busy.says)}
              {planned && header('When quiet', 'quiet', MODES.quiet.says)}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((family) => {
              const last = Object.values(family.measured ?? {}).at(-1);
              return (
                <Table.Tr key={family.name}>
                  <Table.Td>
                    <FamilyName family={family} />
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={6}>
                      {family.copies.length === 0 && <Badge size='sm' variant='light' color='gray'>not loaded</Badge>}
                      {family.copies.map((copy) => (
                        <Tooltip key={copy.key} label={`${copy.key}${copy.worker ? ` in the ${copy.worker} worker` : ''}`} withArrow>
                          <Badge
                            size='sm'
                            variant='light'
                            color={copyColor(copy)}
                            leftSection={copy.state !== 'loaded' ? <Loader size={10} color={copyColor(copy)} /> : undefined}
                          >
                            {copyLabel(copy)}
                          </Badge>
                        </Tooltip>
                      ))}
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <PerCopy
                      family={family}
                      render={(copy) => copy.since === undefined ? '—' : copy.state === 'loaded' ? `${ago(copy.since)} ago` : `${copy.state} ${ago(copy.since)}`}
                      time={(copy) => copy.since}
                    />
                  </Table.Td>
                  <Table.Td>
                    <PerCopy family={family} render={(copy) => copy.lastUsed === undefined ? '—' : `${ago(copy.lastUsed)} ago`} time={(copy) => copy.lastUsed} />
                  </Table.Td>
                  <Table.Td>
                    {family.copies.length === 0 ? <Size size={last} last /> : (
                      <Stack gap={6}>
                        {family.copies.map((copy) => <Size key={copy.key} size={copy.state === 'loading' ? undefined : copy} />)}
                      </Stack>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Activity family={family} />
                  </Table.Td>
                  {planned && <Table.Td>{family.plan && <Placement placement={family.plan.busy} />}</Table.Td>}
                  {planned && <Table.Td>{family.plan && <Placement placement={family.plan.quiet} why={family.plan.why} />}</Table.Td>}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

/** One line per copy, so a family on the GPU and the CPU at once lines up across the columns. */
function PerCopy({ family, render, time }: { family: EmsFamily; render: (copy: EmsModelCopy) => string; time: (copy: EmsModelCopy) => number | undefined }) {
  if (family.copies.length === 0) return <Text size='xs' c='dimmed'>—</Text>;
  return (
    <Stack gap={6}>
      {family.copies.map((copy) => {
        const at = time(copy);
        return (
          <Tooltip key={copy.key} label={at !== undefined ? clock(at) : ''} withArrow disabled={at === undefined}>
            <Text size='xs' ff='monospace' lh='22px'>{render(copy)}</Text>
          </Tooltip>
        );
      })}
    </Stack>
  );
}

function Activity({ family }: { family: EmsFamily }) {
  if (!family.running && family.waiting === 0) return <Text size='xs' c='dimmed'>idle</Text>;
  return (
    <Group gap={6} wrap='nowrap'>
      {family.running && <Badge size='sm' variant='dot' color='teal'>running</Badge>}
      {family.waiting > 0 && <Text size='xs' c='dimmed'>{family.waiting} waiting</Text>}
    </Group>
  );
}

/**
 * What each request is doing. In the models lane "admitted" is not "running": the lane admits
 * several, and each model runs one at a time. So per model the oldest admitted request is the one
 * running and the rest are waiting for it — the order the model's lock serves them in, except when
 * an interactive request jumps the queue. A request that names no model yet is still preparing
 * its input (extracting a video's audio) before it asks for one.
 */
const requestStates = (requests: EmsRequest[], families: EmsFamily[]): Map<EmsRequest, { label: string; color: string }> => {
  const busy = new Set(families.filter((family) => family.running).map((family) => family.name));
  const states = new Map<EmsRequest, { label: string; color: string }>();
  const seen = new Set<string>();
  const oldestFirst = [...requests].sort((a, b) => (a.started ?? Infinity) - (b.started ?? Infinity));
  for (const request of oldestFirst) {
    if (request.started === undefined) {
      states.set(request, { label: `queued in ${request.lane}`, color: 'gray' });
    } else if (request.lane === 'models' && !request.family) {
      // Admitted, but has not asked for a model yet: it is reading or extracting its input
      // (the audio of a video) first, which is EMS's own work and holds the slot meanwhile.
      states.set(request, { label: 'preparing input', color: 'blue' });
    } else if (request.family && busy.has(request.family) && seen.has(request.family)) {
      states.set(request, { label: `waiting for ${request.family}`, color: 'yellow' });
    } else {
      states.set(request, { label: 'running', color: 'teal' });
      if (request.family) seen.add(request.family);
    }
  }
  return states;
};

/** One lane, a column of the Executing card rather than a box in it. */
function Lane({ name, lane }: { name: string; lane: EmsLane }) {
  const pct = (lane.running / lane.limit) * 100;
  return (
    <Box>
      <Group justify='space-between' mb={4}>
        <Text size='sm' fw={600}>{name}</Text>
        <Text size='xs' ff='monospace'>
          {lane.running}/{lane.limit}
          {lane.waiting > 0 && <Text span c='orange' size='xs'>· {lane.waiting} queued</Text>}
        </Text>
      </Group>
      <Progress value={Math.min(100, pct)} size={6} color={utilizationColor(pct)} mb={6} />
      <Text size='xs' c='dimmed'>{LANES[name] ?? 'An admission queue of EMS.'}</Text>
      {lane.reserve > 0 && <Text size='xs' c='dimmed' mt={4}>{lane.reserve} more slot(s) kept for interactive work, so a person never waits behind indexing.</Text>}
    </Box>
  );
}

/**
 * The callers EMS serves, when there is more than one: a freed slot goes to the one that has used
 * the least for its weight, so this is where one core's crawl crowding out another's would show.
 */
function Callers({ callers }: { callers: Record<string, EmsCaller> }) {
  return (
    <Box mb='md'>
      <Text size='sm' fw={500} mb={4}>Callers</Text>
      <Text size='xs' c='dimmed' mb='xs'>
        The systems that send EMS work, each by the name its key has. When requests wait, the next slot goes to the caller that has used EMS the least for its weight.
      </Text>
      <Table.ScrollContainer minWidth={420}>
        <Table verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Caller</Table.Th>
              <Table.Th ta='right'>Weight</Table.Th>
              <Table.Th ta='right'>Used</Table.Th>
              <Table.Th ta='right'>Running</Table.Th>
              <Table.Th ta='right'>Waiting</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {Object.entries(callers).map(([name, caller]) => (
              <Table.Tr key={name}>
                <Table.Td>
                  <Text size='sm' ff='monospace'>{name}</Text>
                </Table.Td>
                <Table.Td ta='right'>
                  <Text size='xs'>{caller.weight}</Text>
                </Table.Td>
                <Table.Td ta='right'>
                  <Tooltip label='Slot-seconds held since EMS started, running requests included' withArrow>
                    <Text size='xs' ff='monospace'>{formatUptime(caller.usedSeconds * 1000)}</Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td ta='right'>
                  <Text size='xs'>{caller.running}</Text>
                </Table.Td>
                <Table.Td ta='right'>
                  <Text size='xs' c={caller.waiting > 0 ? 'orange' : undefined}>{caller.waiting}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Box>
  );
}

function Requests(
  { requests, queues, callers, families }: { requests: EmsRequest[]; queues?: Running['queues']; callers?: Record<string, EmsCaller>; families: EmsFamily[] },
) {
  const states = requestStates(requests, families);
  const rows = [...requests].sort((a, b) => (a.started ?? Infinity) - (b.started ?? Infinity) || a.queued - b.queued);
  const hasFamilies = rows.some((request) => request.family);
  const several = Object.keys(callers ?? {}).length > 1;

  return (
    <Card>
      <Group gap='xs' mb='xs'>
        <Title order={4}>Executing</Title>
        <Text size='sm' c='dimmed' ml='auto'>{`${requests.length} request(s)`}</Text>
      </Group>
      <Text size='xs' c='dimmed' mb='sm'>
        Every request to EMS goes through one of its lanes — queues that bound how much of each kind of work runs at once. Only the models lane uses the models above.
      </Text>
      {queues && (
        <SimpleGrid cols={{ base: 1, sm: Math.min(3, Object.keys(queues).length) }} spacing='lg' mb='md'>
          {Object.entries(queues).map(([name, lane]) => <Lane key={name} name={name} lane={lane} />)}
        </SimpleGrid>
      )}
      {several && callers && <Callers callers={callers} />}
      {rows.length === 0 ? <Text size='sm' c='dimmed'>Nothing running</Text> : (
        <Table.ScrollContainer minWidth={560}>
          <Table striped verticalSpacing='xs'>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Operation</Table.Th>
                {several && <Table.Th>Caller</Table.Th>}
                <Table.Th>Lane</Table.Th>
                {hasFamilies && <Table.Th>Model</Table.Th>}
                <Table.Th>State</Table.Th>
                <Table.Th ta='right'>For</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((request, index) => {
                const state = states.get(request) ?? { label: 'running', color: 'teal' };
                return (
                  <Table.Tr key={`${request.op}-${request.queued}-${index}`}>
                    <Table.Td>
                      <Group gap={6} wrap='nowrap'>
                        <Text size='sm' ff='monospace'>{request.op}</Text>
                        {request.interactive && <Badge size='xs' variant='light' color='violet'>interactive</Badge>}
                      </Group>
                    </Table.Td>
                    {several && (
                      <Table.Td>
                        <Text size='xs' ff='monospace'>{request.caller ?? '—'}</Text>
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Text size='xs' c='dimmed'>{request.lane}</Text>
                    </Table.Td>
                    {hasFamilies && (
                      <Table.Td>
                        <Text size='xs' ff='monospace'>{request.family ?? '—'}</Text>
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Badge size='sm' variant='light' color={state.color} tt='none'>{state.label}</Badge>
                    </Table.Td>
                    <Table.Td ta='right'>
                      <Tooltip
                        label={`Queued ${new Date(request.queued * 1000).toLocaleTimeString()}${
                          request.started !== undefined ? `, admitted ${new Date(request.started * 1000).toLocaleTimeString()}` : ''
                        }`}
                        withArrow
                      >
                        <Text size='xs' ff='monospace'>{ago(request.started ?? request.queued)}</Text>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}
