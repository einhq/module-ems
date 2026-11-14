import { Group, NumberInput, Paper, SegmentedControl, Select, Skeleton, Stack, Switch, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { ConfigEntry } from '@ein/api';
import { SaveBar, settingOf, SettingSource, useViewSave } from '@ein/ui/components';
import { useConfig } from '@ein/ui/hooks';

/** Languages whisper transcribes, as the codes it takes, offered by name. */
const LANGUAGES = [
  'ar',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'hu',
  'is',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'nl',
  'nn',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sv',
  'tr',
  'uk',
  'zh',
];

const DETECT = 'detect';

/** A choice that leaves the setting empty: what the media service has. */
const SERVICE = 'service';

/** A language's own name in English: `Swedish` for `sv`. */
const languageName = (code: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** `''` throughout is what the media service has, as the settings' empty value means. */
type Draft = { language: string; silence: string; words: string; current: boolean };

const KEYS = ['CFG_WHISPER_LANGUAGE', 'CFG_WHISPER_VAD_MIN_SILENCE_MS', 'CFG_WHISPER_WORD_TIMESTAMPS'] as const;

/** A setting's label with where its value comes from. */
function Label({ text, entry }: { text: string; entry: ConfigEntry }) {
  return (
    <Group justify='space-between' wrap='nowrap'>
      <Text fw={600} size='sm'>{text}</Text>
      <SettingSource entry={entry} />
    </Group>
  );
}

/**
 * Transcription, a settings view of ems's (`ems.transcription`, a `settings.views` panel): what
 * EiN asks of the media service when it transcribes a recording — the language spoken, or that it
 * is detected (`CFG_WHISPER_LANGUAGE`), the pause that ends a stretch of speech
 * (`CFG_WHISPER_VAD_MIN_SILENCE_MS`) and whether every word is timed
 * (`CFG_WHISPER_WORD_TIMESTAMPS`), each also left to the media service; and, where a module
 * declares it, whether transcripts made with other settings are made again
 * (`CFG_MEDIA_TRANSCRIPTS_CURRENT`). Saved together.
 */
export default function TranscriptionSettings() {
  const config = useConfig('system');
  const save = useViewSave();
  const [language, silence, words] = KEYS.map((key) => settingOf(config.entries, key));
  const current = settingOf(config.entries, 'CFG_MEDIA_TRANSCRIPTS_CURRENT');

  const saved = useMemo<Draft | undefined>(
    () => language && silence && words ? { language: language.value, silence: silence.value, words: words.value, current: current?.value !== 'off' } : undefined,
    [language?.value, silence?.value, words?.value, current?.value],
  );
  const [draft, setDraft] = useState<Draft | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);

  if (config.loading) return <Skeleton height={360} radius='md' />;
  if (!saved || !language || !silence || !words) return <Text c='dimmed'>{config.error?.message ?? 'The transcription settings did not load.'}</Text>;
  if (!draft) return <Skeleton height={360} radius='md' />;

  const change = (next: Partial<Draft>) => {
    save.clear();
    setDraft({ ...draft, ...next });
  };
  const values: Record<string, string> = {
    CFG_WHISPER_LANGUAGE: draft.language,
    CFG_WHISPER_VAD_MIN_SILENCE_MS: draft.silence,
    CFG_WHISPER_WORD_TIMESTAMPS: draft.words,
    ...(current ? { CFG_MEDIA_TRANSCRIPTS_CURRENT: draft.current ? (current.value === 'off' ? 'on' : current.value) : 'off' } : {}),
  };
  const before: Record<string, string> = {
    CFG_WHISPER_LANGUAGE: saved.language,
    CFG_WHISPER_VAD_MIN_SILENCE_MS: saved.silence,
    CFG_WHISPER_WORD_TIMESTAMPS: saved.words,
    ...(current ? { CFG_MEDIA_TRANSCRIPTS_CURRENT: current.value } : {}),
  };
  const changed = Object.keys(values).filter((key) => values[key] !== before[key]);
  const blocked = draft.silence !== '' && !(Number(draft.silence) > 0) ? 'Give the pause in milliseconds, or leave it to the media service.' : undefined;
  const codes = LANGUAGES.includes(draft.language) || !draft.language ? LANGUAGES : [...LANGUAGES, draft.language];

  // Keeping transcripts current is any value but `off`, and an empty one is refused: on, the value
  // set here goes, or one the deployment set is overridden.
  const write = async () => {
    const turnedOn = changed.includes('CFG_MEDIA_TRANSCRIPTS_CURRENT') && draft.current;
    const set = changed.filter((key) => !(turnedOn && key === 'CFG_MEDIA_TRANSCRIPTS_CURRENT'));
    return [
      ...(set.length > 0 ? [await config.saveAll(Object.fromEntries(set.map((key) => [key, values[key]])))] : []),
      ...(turnedOn
        ? [current!.source === 'system' ? await config.resetAll(['CFG_MEDIA_TRANSCRIPTS_CURRENT']) : await config.saveAll({ CFG_MEDIA_TRANSCRIPTS_CURRENT: 'on' })]
        : []),
    ];
  };

  return (
    <Stack gap='lg'>
      <Paper p='md' radius='md' withBorder>
        <Stack gap='lg'>
          <Stack gap={4}>
            <Label text='Language spoken' entry={language} />
            <Text size='xs' c='dimmed'>
              Detected, the media service hears which language each recording is in, and prefers the ones it is told to expect. Name one only when every recording is in it: a
              recording in another is then written as if it were.
            </Text>
            <Select
              aria-label='Language spoken'
              searchable
              allowDeselect={false}
              data={[
                { value: DETECT, label: 'Detected in each recording' },
                ...codes.map((code) => ({ value: code, label: languageName(code) })).sort((a, b) => a.label.localeCompare(b.label)),
              ]}
              value={draft.language || DETECT}
              disabled={save.busy}
              onChange={(value) => change({ language: !value || value === DETECT ? '' : value })}
              maw={360}
            />
          </Stack>

          <Stack gap={4}>
            <Label text='Pause that ends a stretch of speech' entry={silence} />
            <Text size='xs' c='dimmed'>
              How long someone must be silent before the transcript starts a new line. Shorter makes more and shorter lines; longer keeps a slow speaker's sentence together.
            </Text>
            <Group gap='sm' align='center'>
              <SegmentedControl
                data={[{ value: SERVICE, label: "The media service's" }, { value: 'own', label: 'This long' }]}
                value={draft.silence === '' ? SERVICE : 'own'}
                disabled={save.busy}
                onChange={(value) => change({ silence: value === SERVICE ? '' : saved.silence || '500' })}
              />
              {draft.silence !== '' && (
                <NumberInput
                  aria-label='Pause in milliseconds'
                  suffix=' ms'
                  min={50}
                  step={100}
                  allowNegative={false}
                  allowDecimal={false}
                  value={draft.silence}
                  disabled={save.busy}
                  onChange={(value) => change({ silence: value === '' ? '0' : String(value) })}
                  w={140}
                />
              )}
            </Group>
          </Stack>

          <Stack gap={4}>
            <Label text='Timings' entry={words} />
            <Text size='xs' c='dimmed'>
              Whether the transcript says when each word was said, or only when each line was.
            </Text>
            <SegmentedControl
              data={[{ value: SERVICE, label: "The media service's" }, { value: '1', label: 'Each word' }, { value: '0', label: 'Each line' }]}
              value={draft.words || SERVICE}
              disabled={save.busy}
              onChange={(value) => change({ words: value === SERVICE ? '' : value })}
              style={{ alignSelf: 'flex-start' }}
            />
          </Stack>

          {current && (
            <Stack gap={4}>
              <Label text='Keep transcripts current' entry={current} />
              <Switch
                label='Transcribe again what was transcribed another way'
                description='A recording transcribed with other settings than the media service has now is transcribed again in the background, behind new media. On a large archive a change of settings means hours of that.'
                checked={draft.current}
                disabled={save.busy}
                onChange={(event) => change({ current: event.currentTarget.checked })}
              />
            </Stack>
          )}
        </Stack>
      </Paper>

      <SaveBar save={save} dirty={changed.length > 0} blocked={blocked} onCancel={() => setDraft(saved)} onSave={() => save.run(write)} />
    </Stack>
  );
}
