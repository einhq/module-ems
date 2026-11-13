import { Group, Slider, Stack, Text } from '@mantine/core';
import { execCommand, notify } from '@ein/ui/signals';
import { useEffect, useState } from 'react';
import type { EmsStatus } from '@ems/api';
import { size } from './holdings.ts';

type Running = Extract<EmsStatus, { running: true }>;

/** What a worker's CUDA context takes on the card beside a model's own need, as EMS counts it. */
const CONTEXT_MB = 400;

const STEP_MB = 256;

/** How long a share let go of waits for EMS to report it before the slider shows what EMS says again. */
const REPORT_WAIT_MS = 30_000;

/**
 * The media service's share of the graphics card, under the card's bar: a slider from none of it,
 * every model on the processor, to the whole card. Letting go of it sets `CFG_EMS_CARD_SHARE_MB`,
 * which the `ems-link` service gives EMS; until EMS reports the new share, for half a minute at
 * most, the slider stays where it was let go. Under it, what EMS and the card's other tenants hold
 * now, and which models the share keeps on the processor.
 */
export function CardShare({ status, total }: { status: Running; total: number }) {
  const reported = status.card?.shareMb;
  const now = reported === null || reported === undefined ? total : Math.min(reported, total);
  const [moving, setMoving] = useState<number>();
  const [sent, setSent] = useState<number>();
  useEffect(() => {
    if (sent === undefined) return;
    if (Math.round(sent) === Math.round(now)) {
      setSent(undefined);
      return;
    }
    const timer = setTimeout(() => setSent(undefined), REPORT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [now, sent]);
  const shown = moving ?? sent ?? now;

  const processes = status.gpu?.processes;
  const ems = (processes ?? []).reduce((sum, process) => sum + process.usedMb, 0);
  const others = processes && status.gpu?.memUsedMb !== undefined ? Math.max(0, status.gpu.memUsedMb - ems) : undefined;
  const offCard = status.families
    .filter((family) => family.cardNeedMb !== undefined && family.device !== 'cpu' && family.cardNeedMb + CONTEXT_MB > shown)
    .map((family) => family.name);

  const save = async (value: number) => {
    setMoving(undefined);
    const mb = Math.round(value);
    if (mb === Math.round(now)) return;
    setSent(mb);
    try {
      await execCommand(`config set CFG_EMS_CARD_SHARE_MB ${mb}`);
    } catch (error) {
      setSent(undefined);
      notify({ color: 'red', message: `The media service's share of the card stays as it was: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const share = shown >= total ? `all of the ${size(total)} card` : shown === 0 ? 'none of the card' : `up to ${size(shown)} of the ${size(total)} card`;
  return (
    <Stack gap={6} mt='xs'>
      <Group gap='xs' justify='space-between' wrap='nowrap'>
        <Text size='sm' fw={600}>Media service's share</Text>
        <Text size='sm' c='dimmed'>{shown >= total ? 'the whole card' : size(shown)}</Text>
      </Group>
      <Slider
        aria-label="Media service's share of the graphics card"
        min={0}
        max={total}
        step={STEP_MB}
        value={shown}
        onChange={setMoving}
        onChangeEnd={save}
        label={(value) => (value >= total ? 'the whole card' : size(value))}
        marks={[{ value: 0, label: 'none' }, { value: total, label: 'all' }]}
        mb='md'
      />
      <Text size='xs' c='dimmed'>
        The media service's models hold {share}
        {shown === 0 ? ', so every one of them runs on the processor' : ''}. It holds {size(ems)} now
        {others !== undefined ? `, and other programs, such as a language model, ${size(others)}` : ''}. Lower it to leave the rest of the card to them; a model that does not
        fit runs on the processor, slower.
      </Text>
      {offCard.length > 0 && shown > 0 && <Text size='xs' c='dimmed'>On the processor at this share: {offCard.join(', ')}.</Text>}
    </Stack>
  );
}
