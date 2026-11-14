import { Anchor, Button, Group, Paper, PasswordInput, Skeleton, Slider, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConfigWriteAnswer, HealthCheck } from '@ein/api';
import { SaveBar, settingOf, SettingSource, TablerIcon, useViewSave } from '@ein/ui/components';
import { useCommand, useConfig } from '@ein/ui/hooks';
import type { EmsStatus } from '@ems/api';
import { size } from '../components/holdings.ts';

/** The share's draft: MB, or `''` for the media service's own (`EMS_CARD_SHARE_MB`, by default the whole card). */
type Draft = { url: string; key: string; share: string };

const STEP_MB = 256;

/** The host of an address, or the address itself when it is not one. */
const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).host;
  } catch {
    return url.trim();
  }
};

/** Why an address is no media service's, or nothing when it is one. */
const addressProblem = (url: string): string | undefined =>
  /^https?:\/\/[^/\s]+/.test(url.trim()) ? undefined : 'An address starts http:// or https://, then the host and its port, such as http://127.0.0.1:8181.';

/** A health check as a line with its mark. */
function Check({ check }: { check: HealthCheck }) {
  return (
    <Group gap='xs' wrap='nowrap' align='flex-start'>
      {check.state === 'ok'
        ? <TablerIcon name='circle-check' size={18} color='var(--mantine-color-green-6)' />
        : <TablerIcon name='alert-triangle' size={18} color={`var(--mantine-color-${check.state === 'fail' ? 'red' : 'yellow'}-6)`} />}
      <Text size='sm'>{check.reason}</Text>
    </Group>
  );
}

/**
 * The media service, a settings view of ems's (`ems.settings`, a `settings.views` panel): where
 * EMS answers and the key it expects (`CFG_EMS_URL`, `CFG_EMS_KEY`), and how much of the graphics
 * card its models may hold (`CFG_EMS_CARD_SHARE_MB`), saved as one so `ems-link` restarts once;
 * then whether the primary answers (`ems-status --checks --instance main`). The share is offered
 * when the primary answers with a card it can share.
 */
export default function MediaServiceSettings() {
  const config = useConfig('system');
  const checks = useCommand<HealthCheck[]>('ems-status --checks --instance main');
  const status = useCommand<EmsStatus>('ems-status');
  const save = useViewSave();
  const url = settingOf(config.entries, 'CFG_EMS_URL');
  const key = settingOf(config.entries, 'CFG_EMS_KEY');
  const share = settingOf(config.entries, 'CFG_EMS_CARD_SHARE_MB');

  const saved = useMemo<Draft | undefined>(() => (url && share ? { url: url.value, key: '', share: share.value } : undefined), [url?.value, share?.value]);
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={320} radius='md' />;
  if (!saved || !key || !share) return <Text c='dimmed'>{config.error?.message ?? 'The media service settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={320} radius='md' />;

  const change = (next: Partial<Draft>) => {
    save.clear();
    setDraft({ ...draft, ...next });
  };
  const dirty = draft.url.trim() !== saved.url || draft.key !== '' || draft.share !== saved.share;
  const sameHost = hostOf(draft.url) === hostOf(saved.url);
  const keySet = key.source !== 'default';
  const problem = addressProblem(draft.url);
  const blocked = problem ??
    (!sameHost && !draft.key && key.source === 'environment'
      ? "The key in the installation's .env belongs to the media service it names there; give this one its own."
      : undefined);

  const running = status.data?.running ? status.data : undefined;
  const total = running?.gpu?.memTotalMb;
  const shareable = total !== undefined && running?.card?.shareMb !== undefined;
  const shown = draft.share === '' ? total ?? 0 : Math.min(Number(draft.share), total ?? Number(draft.share));

  const write = async (): Promise<ConfigWriteAnswer[]> => {
    const answers = [
      await config.saveAll({
        ...(draft.url.trim() !== saved.url ? { CFG_EMS_URL: draft.url.trim() } : {}),
        ...(draft.key ? { CFG_EMS_KEY: draft.key } : {}),
        ...(draft.share !== saved.share && draft.share !== '' ? { CFG_EMS_CARD_SHARE_MB: draft.share } : {}),
      }),
    ];
    // The media service's own share again: the value set here goes.
    if (draft.share !== saved.share && draft.share === '') answers.push(await config.resetAll(['CFG_EMS_CARD_SHARE_MB']));
    // Another media service without a key of its own: the one set here was the old one's.
    if (!sameHost && !draft.key && key.source === 'system') answers.push(await config.resetAll(['CFG_EMS_KEY']));
    return answers;
  };
  const onSave = async () => {
    if (await save.run(write)) setDraft((current) => current && { ...current, key: '' });
    // ems-link gives EMS the share as it restarts; ask once it has had a moment to.
    setTimeout(() => {
      checks.refetch();
      status.refetch();
    }, 2000);
  };

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='sm'>
          <TextInput
            label={
              <Group gap='xs' component='span'>
                Address
                <SettingSource entry={url!} />
              </Group>
            }
            description='Where the media service answers. Every model and media tool EiN uses is asked there: thumbnails, faces, text in pictures, transcripts. The installer runs it beside EiN and sets this.'
            placeholder='http://127.0.0.1:8181'
            value={draft.url}
            error={problem}
            disabled={save.busy}
            onChange={(event) => change({ url: event.currentTarget.value })}
          />
          <PasswordInput
            label={
              <Group gap='xs' component='span'>
                Key
                <SettingSource entry={key} />
              </Group>
            }
            description="The key the media service expects: the first word of this EiN's line in its keys file. Sent to this address alone, and kept where nobody reads it back. Not needed when the media service runs without keys."
            placeholder={sameHost && keySet ? 'Set — type a new one to replace it' : 'None'}
            autoComplete='new-password'
            value={draft.key}
            disabled={save.busy}
            onChange={(event) => change({ key: event.currentTarget.value })}
          />
        </Stack>
      </Paper>

      {shareable && (
        <Paper p='md' radius='md' withBorder>
          <Stack gap={6}>
            <Group justify='space-between' wrap='nowrap'>
              <Text fw={600}>Share of the graphics card</Text>
              <SettingSource entry={share} />
            </Group>
            <Text size='sm' c='dimmed'>
              The most of the {running?.gpu?.name ?? 'card'}'s {size(total)}{' '}
              the media service's models hold. A model that does not fit runs on the processor instead, slower. Lower it to leave room for a language model on the same card.
            </Text>
            <Slider
              aria-label="Media service's share of the graphics card"
              min={0}
              max={total!}
              step={STEP_MB}
              value={shown}
              disabled={save.busy}
              onChange={(value) => change({ share: String(Math.round(value)) })}
              label={(value) => (value >= total! ? 'the whole card' : size(value))}
              marks={[{ value: 0 }, { value: total! }]}
            />
            <Group justify='space-between' mt={-2}>
              <Text size='xs' c='dimmed'>none: every model on the processor</Text>
              <Text size='xs' c='dimmed'>all</Text>
            </Group>
            <Group justify='space-between' wrap='nowrap' gap='xs'>
              <Text size='sm'>
                {draft.share === ''
                  ? "The media service's own share, by default the whole card."
                  : shown >= total!
                  ? 'The whole card.'
                  : shown === 0
                  ? 'None of the card: every model runs on the processor.'
                  : `Up to ${size(shown)}.`}
              </Text>
              {draft.share !== '' && (
                <Button variant='subtle' size='compact-sm' disabled={save.busy} onClick={() => change({ share: '' })}>
                  Its own share
                </Button>
              )}
            </Group>
            <Text size='xs' c='dimmed'>
              What each model holds there now is under <Anchor component={Link} to='/system?tab=ems.media-service' size='xs'>Status → Media service</Anchor>.
            </Text>
          </Stack>
        </Paper>
      )}

      <SaveBar save={save} dirty={dirty} blocked={blocked} onCancel={() => setDraft(saved)} onSave={onSave} />

      <Paper p='md' radius='md' withBorder>
        <Stack gap='xs'>
          <Text fw={600}>Now</Text>
          {checks.data
            ? checks.data.map((check) => <Check key={`${check.name}-${check.reason}`} check={check} />)
            : checks.loading
            ? <Skeleton height={20} />
            : <Text size='sm' c='dimmed'>{checks.error?.message ?? 'No answer.'}</Text>}
        </Stack>
      </Paper>
    </Stack>
  );
}
