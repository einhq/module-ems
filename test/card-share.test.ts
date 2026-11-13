/**
 * The card's share: `CFG_EMS_CARD_SHARE_MB` given to the primary when its health reports another,
 * and the transcripts that count as current wherever the share has EMS decode.
 */

import { assertEquals, assertRejects } from '@std/assert';
import type { Command } from '@ein/client';
import type { EmsCapabilities } from '@ems/api';
import { cardShareSetting, keepCardShare } from '@ems/card-share';
import { EmsError, generations, setCardShare } from '@ems/client';
import { currentTranscripts, generationsDiffer, primaryInstance } from '@ems/instances';
import { startStubEms } from './stub-ems.ts';

/** A Command with `env` and a VFS that holds nothing. */
const makeCmd = (env: Record<string, string>) => {
  const noNode = () => Promise.reject(new Error('not a node'));
  return { env, access: {}, sys: { vfs: { stat: noNode, open: noNode, children: noNode, get: noNode } } } as unknown as Command;
};

Deno.test('the setting is a share in whole MB, and unset is no share at all', () => {
  assertEquals(cardShareSetting({}), undefined);
  assertEquals(cardShareSetting({ CFG_EMS_CARD_SHARE_MB: ' ' }), undefined);
  assertEquals(cardShareSetting({ CFG_EMS_CARD_SHARE_MB: '0' }), 0);
  assertEquals(cardShareSetting({ CFG_EMS_CARD_SHARE_MB: '6000.4' }), 6000);
  assertEquals(cardShareSetting({ CFG_EMS_CARD_SHARE_MB: '-1' }), undefined);
});

Deno.test('the primary is given the share when it reports another, and left alone when not', async () => {
  let share: number | null = 9700;
  const ems = startStubEms({
    health: {
      get card() {
        return { mode: 'busy', share_mb: share };
      },
    },
    ops: {
      card: (body) => {
        share = body.share_mb as number | null;
        return { result: { share_mb: share, unloaded: ['whisper:cuda:float16'] } };
      },
    },
  });
  try {
    const cmd = makeCmd({ CFG_EMS_URL: ems.url });
    const primary = await primaryInstance(cmd);
    assertEquals(await keepCardShare(cmd, primary, 6000), "the card's share set to 6000 MB, from 9700 MB; unloaded whisper:cuda:float16");
    assertEquals(ems.requests.map((request) => [request.op, request.body]), [['card', { share_mb: 6000 }]]);
    assertEquals(await keepCardShare(cmd, primary, 6000), undefined);
    assertEquals(ems.requests.length, 1);
    // EMS restarted with its own share: it is given EiN's again.
    share = null;
    assertEquals(await keepCardShare(cmd, primary, 0), "the card's share set to none of the card, from the whole card; unloaded whisper:cuda:float16");
    assertEquals(await setCardShare(cmd, primary, null), { shareMb: null, unloaded: ['whisper:cuda:float16'] });
  } finally {
    await ems.close();
  }
});

Deno.test('an EMS that cannot change its share, or does not answer, is left alone; a refusal is an error', async () => {
  const old = startStubEms({ health: { card: { mode: 'off' } } });
  const down = startStubEms({ health: null });
  const refusing = startStubEms({
    health: { card: { mode: 'off', share_mb: null } },
    ops: { card: { error: { code: 'invalid_request', message: 'share_mb: Input should be greater than or equal to 0', permanent: true }, status: 400 } },
  });
  try {
    for (const ems of [old, down]) {
      const cmd = makeCmd({ CFG_EMS_URL: ems.url });
      assertEquals(await keepCardShare(cmd, await primaryInstance(cmd), 6000), undefined);
      assertEquals(ems.requests.length, 0);
    }
    const cmd = makeCmd({ CFG_EMS_URL: refusing.url });
    await assertRejects(async () => await keepCardShare(cmd, await primaryInstance(cmd), 6000), EmsError, 'greater than or equal to 0');
  } finally {
    await old.close();
    await down.close();
    await refusing.close();
  }
});

const ON_CARD = 'whisper-large-v3:vad=0.2/800/2000,nospeech=0.8,on=cuda:float16,lang=auto:3,words=0';
const ON_CPU = 'whisper-large-v3:vad=0.2/800/2000,nospeech=0.8,on=cpu:int8,lang=auto:3,words=0';

Deno.test('a transcript decoded in any place the share may put whisper is current', async () => {
  const capabilities: EmsCapabilities = { ops: ['speech.transcribe'], signatures: { transcribe: ON_CPU, transcribe_places: [ON_CARD, ON_CPU] } };
  assertEquals(currentTranscripts(capabilities), [ON_CARD, ON_CPU]);
  assertEquals(currentTranscripts({ signatures: { transcribe: ON_CARD } }), [ON_CARD]);
  assertEquals(currentTranscripts({}), []);
  // Another instance decoding in either place stamps what the primary counts current.
  assertEquals(generationsDiffer(capabilities, { signatures: { transcribe: ON_CARD } }, ['speech.transcribe']), []);
  assertEquals(generationsDiffer(capabilities, { signatures: { transcribe: ON_CPU.replace('words=0', 'words=1') } }, ['speech.transcribe']), ['speech.transcribe']);
  assertEquals(generationsDiffer({ ops: ['speech.transcribe'] }, {}, ['speech.transcribe']), []);
  assertEquals(generationsDiffer({ ops: ['speech.transcribe'] }, { signatures: { transcribe: ON_CPU } }, ['speech.transcribe']), ['speech.transcribe']);

  const ems = startStubEms({ capabilities: { signatures: capabilities.signatures } });
  try {
    const now = await generations(makeCmd({ CFG_EMS_URL: ems.url }));
    assertEquals([now?.transcribe, now?.transcribeCurrent], [ON_CPU, [ON_CARD, ON_CPU]]);
  } finally {
    await ems.close();
  }
});
