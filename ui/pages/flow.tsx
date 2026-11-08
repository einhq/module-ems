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

const PRIMARY = 'main';

/**
 * One instance's columns: its lanes with their slots and what each runs and keeps waiting, then the
 * models it holds, the working ones first. `ems-status`, polled while the Work tab is shown. Another
 * instance's columns carry its name.
 */
function InstanceFlow({ name }: { name: string }) {
  const { data: status } = usePolledCommand<EmsStatus>(name === PRIMARY ? 'ems-status' : `ems-status --instance ${name}`);
  const at = name === PRIMARY ? 'At the media service' : `At ${name}`;
  const onModel = name === PRIMARY ? 'On a model' : `On a model at ${name}`;
  if (!status) {
    return (
      <FlowColumn title={at} color={WORKLOAD_COLORS.running}>
        <Skeleton height={80} />
      </FlowColumn>
    );
  }
  if (!status.running) {
    return (
      <FlowColumn title={at} color={WORKLOAD_COLORS.failed}>
        <Text size='sm' c='dimmed'>
          Not answering at <Text span ff='monospace' size='sm'>{status.url}</Text>;{' '}
          {name === PRIMARY ? 'the steps that need it wait.' : 'its work goes to the other instances.'}
        </Text>
      </FlowColumn>
    );
  }

  const several = Object.keys(status.callers ?? {}).length > 1;
  const holdings = holdingsOf(status).filter((holding) => holding.state !== 'unloading');
  const indexing = holdings.filter((holding) => !holding.search).sort((a, b) => Number(b.working) - Number(a.working));
  const search = holdings.filter((holding) => holding.search);
  const families = new Set(holdings.map((holding) => holding.family));

  // No row of its own: the columns sit in the board's row, and share its width with EiN's.
  return (
    <>
      <FlowColumn
        title={at}
        count={status.requests.length}
        color={WORKLOAD_COLORS.running}
        hint='Its lanes. A request waits here only when its lane is full.'
      >
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
      </FlowColumn>

      <FlowArrow />

      <FlowColumn title={onModel} count={families.size} color={CARD_COLOR} hint='What is loaded, and where; the working ones first.'>
        <Stack gap={4}>
          {indexing.map((holding) => <ModelRow key={holding.key} holding={holding} />)}
          {indexing.length === 0 && <Text size='xs' c='dimmed'>No indexing model loaded</Text>}
          {search.length > 0 && <FlowGroupLabel>for search</FlowGroupLabel>}
          {search.map((holding) => <ModelRow key={holding.key} holding={holding} />)}
        </Stack>
      </FlowColumn>
    </>
  );
}

/**
 * The media service's part of the Work tab's flow board (`ems.flow`, a `system.flow` panel in
 * ems's `nav.json`): the primary's columns, then each other instance's (`ems-instance list`).
 */
export default function FlowPanel() {
  const { data: others } = usePolledCommand<string[]>('ems-instance list --others --names');
  return (
    <>
      <InstanceFlow name={PRIMARY} />
      {(others ?? []).map((name) => <InstanceFlow key={name} name={name} />)}
    </>
  );
}
