import { Badge, Box, Group, Skeleton, Stack, Text } from '@mantine/core';
import { FlowArrow, FlowColumn, FlowGroupLabel, FlowItem, FlowSlots, WORKLOAD_COLORS } from '@ein/ui/components';
import { usePolledCommand } from '@ein/ui/hooks';
import type { EmsRequest, EmsStatus } from '@ems/api';
import { CARD_COLOR, type Holding, holdingsOf, size } from '../components/holdings.ts';

/** `faces.detect ×4`, with the caller in front when more than one sends work. */
const tally = (requests: EmsRequest[], callers: boolean): { label: string; waiting: boolean }[] => {
  const counts = new Map<string, { n: number; waiting: boolean }>();
  for (const request of requests) {
    const waiting = request.started === undefined;
    const label = `${callers && request.caller ? `${request.caller}: ` : ''}${request.op}${waiting ? ' (waiting)' : ''}`;
    const entry = counts.get(label) ?? { n: 0, waiting };
    entry.n += 1;
    counts.set(label, entry);
  }
  return [...counts].map(([label, { n, waiting }]) => ({ label: n > 1 ? `${label} ×${n}` : label, waiting }));
};

function ModelRow({ holding }: { holding: Holding }) {
  return (
    <FlowItem active={holding.working}>
      <Group gap='xs' wrap='nowrap'>
        {holding.working && <Box w={7} h={7} style={{ borderRadius: '50%', background: WORKLOAD_COLORS.running, flexShrink: 0 }} />}
        <Text size='sm' ff='monospace' style={{ flex: 1 }} truncate>{holding.family}</Text>
        <Badge size='sm' variant='light' color={holding.place === 'card' ? 'teal' : 'blue'} tt='none'>
          {holding.place === 'card' ? 'GPU' : 'RAM'} {size(holding.mb)}
        </Badge>
      </Group>
      {(holding.state !== 'loaded' || holding.standby) && <Text size='xs' c='dimmed'>{holding.state !== 'loaded' ? holding.state : 'standby, for when indexing starts'}</Text>}
    </FlowItem>
  );
}

/** One instance's lanes, with their slots and what each runs and keeps waiting. */
function Lanes({ status }: { status: Extract<EmsStatus, { running: true }> }) {
  const several = Object.keys(status.callers ?? {}).length > 1;
  return (
    <>
      {Object.entries(status.queues ?? {}).map(([name, lane]) => {
        const mine = status.requests.filter((request) => request.lane === name);
        return (
          <FlowItem key={name}>
            <Group gap='xs' wrap='nowrap' mb={4}>
              <Text size='sm' fw={600} style={{ flex: 1 }}>{name}</Text>
              <Text size='xs' c='dimmed'>
                {lane.running} / {lane.limit}
                {lane.reserve > 0 ? ` · +${lane.reserve} for search` : ''}
              </Text>
            </Group>
            <FlowSlots used={lane.running} total={lane.limit} reserved={lane.reserve} label={`${lane.running} of ${lane.limit} running, ${lane.waiting} waiting`} />
            {mine.length > 0 && (
              <Group gap={4} mt={6}>
                {tally(mine, several).map((entry) => (
                  <Badge key={entry.label} size='sm' variant={entry.waiting ? 'outline' : 'light'} color={entry.waiting ? 'yellow' : 'gray'} tt='none'>
                    {entry.label}
                  </Badge>
                ))}
              </Group>
            )}
          </FlowItem>
        );
      })}
    </>
  );
}

/** What one instance holds, the working ones first and the search models apart. */
function Models({ status }: { status: Extract<EmsStatus, { running: true }> }) {
  const holdings = holdingsOf(status).filter((holding) => holding.state !== 'unloading');
  const indexing = holdings.filter((holding) => !holding.search).sort((a, b) => Number(b.working) - Number(a.working));
  const search = holdings.filter((holding) => holding.search);
  return (
    <Stack gap={4}>
      {indexing.map((holding) => <ModelRow key={holding.key} holding={holding} />)}
      {indexing.length === 0 && <Text size='xs' c='dimmed'>No indexing model loaded</Text>}
      {search.length > 0 && <FlowGroupLabel>for search</FlowGroupLabel>}
      {search.map((holding) => <ModelRow key={holding.key} holding={holding} />)}
    </Stack>
  );
}

/**
 * Another instance's group in one of the two columns, under its name: its lanes, or what it holds.
 * Each group asks `ems-status --instance` itself while the Work tab is shown.
 */
function OtherGroup({ name, part }: { name: string; part: 'lanes' | 'models' }) {
  const { data: status } = usePolledCommand<EmsStatus>(`ems-status --instance ${name}`);
  return (
    <>
      <FlowGroupLabel>{name}</FlowGroupLabel>
      {!status && <Skeleton height={40} />}
      {status && !status.running && part === 'lanes' && <Text size='xs' c='dimmed'>Not answering; its work goes to the other instances.</Text>}
      {status?.running && (part === 'lanes' ? <Lanes status={status} /> : <Models status={status} />)}
    </>
  );
}

/**
 * The media service's part of the Work tab's flow board (`ems.flow`, a `system.flow` panel in
 * ems's `nav.json`): its lanes with their slots and what each runs and keeps waiting, then the
 * models it holds, the working ones first. `ems-status`, polled while the Work tab is shown. Each
 * other instance (`ems-instance list`) is a group of its own in both columns, under its name.
 */
export default function FlowPanel() {
  const { data: status } = usePolledCommand<EmsStatus>('ems-status');
  const { data: others } = usePolledCommand<string[]>('ems-instance list --others --names');
  if (!status) {
    return (
      <FlowColumn title='At the media service' color={WORKLOAD_COLORS.running}>
        <Skeleton height={80} />
      </FlowColumn>
    );
  }
  const groups = (part: 'lanes' | 'models') => (others ?? []).map((name) => <OtherGroup key={name} name={name} part={part} />);
  if (!status.running) {
    return (
      <FlowColumn title='At the media service' color={WORKLOAD_COLORS.failed}>
        <Text size='sm' c='dimmed'>
          Not answering at <Text span ff='monospace' size='sm'>{status.url}</Text>; the steps that need it wait.
        </Text>
        {groups('lanes')}
      </FlowColumn>
    );
  }

  const families = new Set(holdingsOf(status).filter((holding) => holding.state !== 'unloading').map((holding) => holding.family));

  // No row of its own: the columns sit in the board's row, and share its width with EiN's.
  return (
    <>
      <FlowColumn
        title='At the media service'
        count={status.requests.length}
        color={WORKLOAD_COLORS.running}
        hint='Its lanes. A request waits here only when its lane is full.'
      >
        <Lanes status={status} />
        {groups('lanes')}
      </FlowColumn>

      <FlowArrow />

      <FlowColumn title='On a model' count={families.size} color={CARD_COLOR} hint='What is loaded, and where; the working ones first.'>
        <Models status={status} />
        {groups('models')}
      </FlowColumn>
    </>
  );
}
