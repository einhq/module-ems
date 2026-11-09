import { Box, Card, Group, Skeleton, Stack, Text, Title, Tooltip } from '@mantine/core';
import { TablerIcon, WAITING_COLOR, WORKLOAD_COLORS } from '@ein/ui/components';
import type { ReactNode } from 'react';
import type { EmsCardMode, EmsModels, EmsModelsSample } from '@ems/api';
import { CARD_COLOR, RAM_COLOR } from './holdings.ts';
import { formatTime } from '@ein/ui/lib';

/** A sample covers the minute after it; a longer gap is time nobody sampled, drawn empty. */
const SAMPLE_MS = 60_000;
const GAP_MS = 5 * SAMPLE_MS;
const ROW = 14;
/** Less than this of the card held by other containers is noise, not a chat model. */
const OTHERS_MB = 256;
const OTHERS_COLOR = 'var(--mantine-color-grape-6)';

type Span = { from: number; to: number };

const MODE_COLORS: Partial<Record<EmsCardMode, string>> = {
  busy: 'var(--mantine-color-yellow-7)',
  quiet: 'var(--mantine-color-teal-8)',
  switching: 'var(--mantine-color-gray-6)',
};

/** Where each sample's reading holds: from its time to the next sample's, or a minute past it after a gap. */
const extents = (samples: { at: number }[], now: number): Span[] =>
  samples.map((sample, index) => {
    const next = samples[index + 1]?.at ?? now;
    return { from: sample.at, to: next - sample.at > GAP_MS ? sample.at + SAMPLE_MS : next };
  });

/** Neighbouring spans where `test` held, joined. */
const spansWhere = (samples: { at: number; value: EmsModelsSample }[], spans: Span[], test: (value: EmsModelsSample) => boolean): Span[] => {
  const out: Span[] = [];
  samples.forEach((sample, index) => {
    if (!test(sample.value)) return;
    const span = spans[index];
    const last = out[out.length - 1];
    if (last && last.to >= span.from) last.to = span.to;
    else out.push({ ...span });
  });
  return out;
};

function Track({ children, label }: { children?: ReactNode; label: string }) {
  return (
    <>
      <Text size='xs' c='dimmed' ta='right' ff='monospace' style={{ whiteSpace: 'nowrap' }}>{label}</Text>
      <Box pos='relative' h={ROW} style={{ borderRadius: 3, background: 'var(--mrx-surface-overlay)' }}>{children}</Box>
    </>
  );
}

/**
 * The last hours of what the media service held, a row per model that was loaded: solid where it
 * was on the card, outlined where it was in RAM, with a line under it while a request used it; above
 * them the card's mode, what other containers held of the card (the chat model), and EiN's work waiting at the same times (`ems-models`, from the `ems-models`
 * series). A model loaded again and again is a row that flickers; a search model on the card and in
 * RAM at once is its standby copy.
 */
export function ModelTimeline({ history }: { history?: EmsModels | null }) {
  if (!history) return <Skeleton height={160} />;
  const samples = history.samples;
  const now = Date.now();
  const start = now - history.windowMs;
  const x = (at: number) => `${(Math.max(0, at - start) / (now - start)) * 100}%`;
  const w = (span: Span) => `${(Math.max(0, Math.min(span.to, now) - Math.max(span.from, start)) / (now - start)) * 100}%`;
  const spans = extents(samples, now);

  const families = [...new Set(samples.flatMap((sample) => sample.value.copies.map((copy) => copy.family)))].sort();
  const peak = Math.max(1, ...samples.map((sample) => (sample.value.inLine ?? 0) + (sample.value.notStarted ?? 0)));
  const hours = Math.round((now - start) / 3600_000);
  const ticks = Array.from({ length: hours + 1 }, (_, index) => start + index * 3600_000);

  return (
    <Card>
      <Group gap='xs' mb='sm'>
        <TablerIcon name='timeline' size={18} />
        <Title order={5}>The last {hours} hours</Title>
        <Text size='xs' c='dimmed' ml='auto'>solid: on the card · outlined: in RAM · underlined: working</Text>
      </Group>
      {samples.length === 0 ? <Text size='sm' c='dimmed'>Nothing sampled yet: the ems-sampler service writes a sample a minute.</Text> : (
        <Box style={{ overflowX: 'auto' }}>
          <Box miw={560} style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 10px', alignItems: 'center' }}>
            <Text size='xs' c='dimmed' ta='right'>work waiting</Text>
            <Tooltip label={`At most ${peak.toLocaleString()} waiting: in line for a worker over not started yet`} withArrow>
              <Box h={30}>
                <svg width='100%' height='30' viewBox='0 0 1000 30' preserveAspectRatio='none' role='img' aria-label='Work waiting in EiN over the window'>
                  {(['notStarted', 'inLine'] as const).map((field) => {
                    const points = samples.map((sample) => {
                      const value = field === 'inLine' ? (sample.value.inLine ?? 0) : (sample.value.inLine ?? 0) + (sample.value.notStarted ?? 0);
                      return `${((sample.at - start) / (now - start)) * 1000},${30 - (value / peak) * 28}`;
                    });
                    const first = (samples[0].at - start) / (now - start) * 1000;
                    const last = (samples[samples.length - 1].at - start) / (now - start) * 1000;
                    return (
                      <path
                        key={field}
                        d={`M${first},30 L${points.join(' L')} L${last},30 Z`}
                        fill={field === 'inLine' ? WORKLOAD_COLORS.queued : WAITING_COLOR}
                        fillOpacity={field === 'inLine' ? 0.6 : 0.35}
                      />
                    );
                  })}
                </svg>
              </Box>
            </Tooltip>

            <Track label='card mode'>
              {(['busy', 'quiet', 'switching'] as const).flatMap((mode) =>
                spansWhere(samples, spans, (value) => value.mode === mode).map((span) => (
                  <Tooltip key={`${mode}-${span.from}`} label={`${mode}, ${formatTime(span.from)}–${formatTime(span.to)}`} withArrow>
                    <Box pos='absolute' top={2} bottom={2} left={x(span.from)} w={w(span)} style={{ borderRadius: 2, background: MODE_COLORS[mode] }} />
                  </Tooltip>
                ))
              )}
            </Track>

            {samples.some((sample) => (sample.value.othersMb ?? 0) >= OTHERS_MB) && (
              <Track label='chat model and others'>
                {spansWhere(samples, spans, (value) => (value.othersMb ?? 0) >= OTHERS_MB).map((span) => (
                  <Box key={`others-${span.from}`} pos='absolute' top={2} bottom={2} left={x(span.from)} w={w(span)} style={{ borderRadius: 2, background: OTHERS_COLOR }} />
                ))}
              </Track>
            )}

            {families.map((family) => (
              <Track key={family} label={family}>
                {spansWhere(samples, spans, (value) => value.copies.some((copy) => copy.family === family && copy.place === 'ram')).map((span) => (
                  <Box
                    key={`ram-${span.from}`}
                    pos='absolute'
                    top={2}
                    bottom={2}
                    left={x(span.from)}
                    w={w(span)}
                    style={{ borderRadius: 2, border: `1.5px solid ${RAM_COLOR}` }}
                  />
                ))}
                {spansWhere(samples, spans, (value) => value.copies.some((copy) => copy.family === family && copy.place === 'card')).map((span) => (
                  <Box key={`card-${span.from}`} pos='absolute' top={2} bottom={2} left={x(span.from)} w={w(span)} style={{ borderRadius: 2, background: CARD_COLOR }} />
                ))}
                {spansWhere(samples, spans, (value) => value.working.includes(family)).map((span) => (
                  <Box key={`work-${span.from}`} pos='absolute' bottom={0} h={2} left={x(span.from)} w={w(span)} style={{ background: WORKLOAD_COLORS.running }} />
                ))}
              </Track>
            ))}

            <Box />
            <Group justify='space-between' wrap='nowrap'>
              {ticks.map((tick, index) => (
                <Text key={tick} size='xs' c='dimmed'>
                  {index === ticks.length - 1 ? 'now' : formatTime(tick, { hour: '2-digit', minute: '2-digit' })}
                </Text>
              ))}
            </Group>
          </Box>
        </Box>
      )}
      <Stack gap={0} mt='xs'>
        <Text size='xs' c='dimmed'>Card mode: yellow while indexing has the card, green while it is quiet and search has it.</Text>
      </Stack>
    </Card>
  );
}
