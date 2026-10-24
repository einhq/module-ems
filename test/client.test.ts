/**
 * Unit tests for the EMS client. Fast tier: no VFS, no models — a stub EMS on loopback stands in
 * for the service (see stub-ems.ts).
 *
 * What matters here is the three-way outcome everything downstream depends on: unreachable (or
 * busy, or a worker still loading) is `EmsUnavailableError` and the step retries; an answered
 * failure is `EmsError` carrying the API's `permanent`; and a `null` result means "nothing
 * found", not "no service".
 */

import { assert, assertAlmostEquals, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { Command } from '@ein/client';
import {
  activeSpeakers,
  detectFaces,
  embedTexts,
  EmsError,
  EmsUnavailableError,
  extractText,
  fingerprint,
  health,
  transcribe,
  transcribeSignature,
  voiceprint,
} from '../lib/client.ts';
import { startStubEms } from './stub-ems.ts';

/** Minimal Command: env, a VFS with no nodes (every path is already a host path, and no key is set). */
const makeCmd = (env: Record<string, string>, interrupted = false) => {
  const stderr: string[] = [];
  const noNode = () => Promise.reject(new Error('not a node'));
  const cmd = {
    env,
    access: {},
    interrupted,
    sys: { vfs: { stat: noNode, open: noNode, children: noNode } },
    execute: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }),
    writeError: (text: string) => {
      stderr.push(text);
      return Promise.resolve();
    },
  } as unknown as Command;
  return { cmd, stderr };
};

Deno.test('transcribe forwards the whisper settings that are set and derives model and signature', async () => {
  const stub = startStubEms({
    ops: {
      'speech.transcribe': {
        result: { speech: true, text: 'hej', segments: [{ start: 0, end: 1, text: 'hej' }], language: 'sv', language_probability: 0.9, duration: 1.2 },
        producer: 'whisper-large-v3:vad=0.2/400/500,nospeech=0.6,lang=sv,words=0',
      },
    },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url, CFG_WHISPER_LANGUAGE: 'sv', CFG_WHISPER_VAD_MIN_SILENCE_MS: '500', CFG_WHISPER_WORD_TIMESTAMPS: '' });
    const result = await transcribe(cmd, '/tmp/audio.wav');
    assertEquals(result.model, 'whisper-large-v3');
    assertEquals(result.signature, 'whisper-large-v3:vad=0.2/400/500,nospeech=0.6,lang=sv,words=0');
    assertEquals(result.segments.length, 1);
    assertEquals(result.language, 'sv');
    assertEquals(result.languageProbability, 0.9);
    assertEquals(result.duration, 1.2);
    assertEquals(stub.requests[0].body, { file: { path: '/tmp/audio.wav', angle: 0, mirror: false }, language: 'sv', vad: { min_silence_ms: 500 } });
  } finally {
    await stub.close();
  }
});

Deno.test('a streamed request hands over EMS progress before returning its result', async () => {
  const result = { speech: false, audio: true, duration: 1, turns: [], speakers: [] };
  const stub = startStubEms({
    ops: { 'speech.voiceprint': { result, producer: 'diar_sortformer_4spk-v1+titanet' } },
    progress: { 'speech.voiceprint': ['diarize'] },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    const phases: string[] = [];
    const answer = await voiceprint(cmd, '/f/a.wav', {
      onProgress: (phase) => {
        phases.push(phase);
      },
    });
    assertEquals(phases, ['diarize']);
    assertEquals(answer.duration, 1);
  } finally {
    await stub.close();
  }
});

Deno.test('embedTexts returns the vectors and their producer; an interactive caller gives EMS a minute of deadline', async () => {
  const stub = startStubEms({ ops: { 'text.embed': { result: { embeddings: [[0.1, 0.2]], dimension: 2 }, producer: 'jina-embeddings-v5-text-small' } } });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    assertEquals(await embedTexts(cmd, ['hello']), { vectors: [[0.1, 0.2]], producer: 'jina-embeddings-v5-text-small' });
    assertEquals(stub.requests[0].body, { texts: ['hello'], model: 'current', role: 'document' });
    await embedTexts(cmd, ['hello'], { interactive: true, role: 'query' });
    const options = stub.requests[1].body.options as { priority: string; deadline: number };
    assertEquals(options.priority, 'interactive');
    assertAlmostEquals(options.deadline - Date.now() / 1000, 60, 2);
  } finally {
    await stub.close();
  }
});

Deno.test('detectFaces keeps EMS fractions and numbers the faces', async () => {
  const stub = startStubEms({
    ops: {
      'faces.detect': {
        result: {
          frame: { width: 200, height: 100 },
          faces: [{ box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.9, embedding: [1], landmarks: [[0.15, 0.15]], pose: { pitch: 1, yaw: -20, roll: 3 } }],
        },
      },
    },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    const found = await detectFaces(cmd, '/f/a.jpg', 270, false);
    assertEquals(found.frame, { width: 200, height: 100 });
    assertEquals(found.faces, [{
      index: 0,
      box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      confidence: 0.9,
      embedding: [1],
      landmarks: [[0.15, 0.15]],
      pose: { pitch: 1, yaw: -20, roll: 3 },
    }]);
    assertEquals(stub.requests[0].body, { file: { path: '/f/a.jpg', angle: 270, mirror: false } });
  } finally {
    await stub.close();
  }
});

Deno.test('the speech ops map EMS shapes onto the client types', async () => {
  const face = { id: 'speaker_0', score: 0.8, t: 1.2, box: { x: 0, y: 0, width: 0.5, height: 0.5 }, confidence: 0.9, embedding: [0.5, 0.5] };
  const stub = startStubEms({
    ops: {
      'speech.voiceprint': {
        result: {
          speech: true,
          audio: true,
          duration: 10,
          turns: [{ start: 0, end: 2, speaker: 'speaker_0', embedding: [1, 2], dimension: 2 }, { start: 5, end: 5.4, speaker: null, embedding: null, dimension: null }],
          speakers: [{ id: 'speaker_0', turns: [[0, 2]], talkSeconds: 2, vector: [0.4, 0.9], dimension: 2 }],
        },
        producer: 'diar_sortformer_4spk-v1+titanet',
      },
      'speech.active_speakers': { result: { speakers: [face], windows: 1, frames: 50 } },
    },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    assertEquals(await voiceprint(cmd, '/f/a.mp4'), {
      turns: [{ start: 0, end: 2, speaker: 'speaker_0' }, { start: 5, end: 5.4, speaker: null }],
      speakers: [{ id: 'speaker_0', turns: [[0, 2]], talkSeconds: 2, vector: [0.4, 0.9] }],
      speech: true,
      audio: true,
      duration: 10,
      model: 'diar_sortformer_4spk-v1+titanet',
    });
    assertEquals(stub.requests[0].body, { file: { path: '/f/a.mp4', angle: 0, mirror: false } });
    assertEquals(await activeSpeakers(cmd, '/f/a.mp4', 90, false, [{ id: 'speaker_0', turns: [[0, 2]] }]), [face]);
    assertEquals(stub.requests[1].body, {
      file: { path: '/f/a.mp4', angle: 90, mirror: false },
      speakers: [{ id: 'speaker_0', turns: [[0, 2]] }],
    });
  } finally {
    await stub.close();
  }
});

Deno.test('fingerprint and extractText translate field names', async () => {
  const stub = startStubEms({
    ops: {
      'fingerprint.compute': { result: { fingerprints: [{ kind: 'sscd-image', dimension: 2, vector: [0.6, 0.8], label: 'primary' }] }, producer: 'sscd_disc_mixup' },
      'document.extract': { result: { text: 'hello world', pages: 2, method: 'pdf-text', word_count: 2 } },
    },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    assertEquals(await fingerprint(cmd, '/f/a.jpg', { angle: 90, mirror: true, mimetype: 'image/jpeg' }), {
      fingerprints: [{ type: 'sscd-image', dimension: 2, vector: [0.6, 0.8], label: 'primary' }],
      producer: 'sscd_disc_mixup',
    });
    assertEquals(stub.requests[0].body, { file: { path: '/f/a.jpg', angle: 90, mirror: true, mimetype: 'image/jpeg' } });
    assertEquals(await extractText(cmd, '/f/a.pdf', 'application/pdf'), { text: 'hello world', pages: 2, method: 'pdf-text', wordCount: 2 });
    assertEquals(stub.requests[1].body, { file: { path: '/f/a.pdf', mimetype: 'application/pdf' } });
  } finally {
    await stub.close();
  }
});

Deno.test('a chromaprint comes back as its values, not a vector', async () => {
  const stub = startStubEms({
    ops: { 'fingerprint.compute': { result: { fingerprints: [{ kind: 'chromaprint', fingerprint: [1, 4294967295], label: 'primary' }] } } },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    assertEquals((await fingerprint(cmd, '/f/a.m4a', { mimetype: 'audio/mp4' })).fingerprints, [{ type: 'chromaprint', fingerprint: [1, 4294967295], label: 'primary' }]);
  } finally {
    await stub.close();
  }
});

Deno.test('an answered failure is EmsError with the API permanence; busy and a loading worker are unavailability', async () => {
  const stub = startStubEms({
    ops: {
      'faces.detect': { error: { code: 'unsupported', message: 'could not load image', permanent: true }, status: 415 },
      'text.embed': { error: { code: 'busy', message: 'models: queue is full', permanent: false }, status: 503 },
      'speech.transcribe': { error: { code: 'model_unavailable', message: 'model worker is not answering', permanent: false }, status: 503 },
    },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    const error = await assertRejects(() => detectFaces(cmd, '/f/a.jpg'), EmsError);
    assertEquals(error.code, 'unsupported');
    assertEquals(error.permanent, true);
    assertEquals(error.status, 415);
    assertStringIncludes(error.message, 'faces.detect: could not load image');
    await assertRejects(() => embedTexts(cmd, ['x']), EmsUnavailableError, 'busy');
    await assertRejects(() => transcribe(cmd, '/f/a.wav'), EmsUnavailableError, 'model_unavailable');
  } finally {
    await stub.close();
  }
});

Deno.test('no EMS at all is unavailability, never an exception of another shape', async () => {
  // CFG_EMS_CONNECT_RETRY=0: a batch call would otherwise wait out the restart budget first.
  const { cmd } = makeCmd({ CFG_EMS_URL: 'http://127.0.0.1:1', CFG_EMS_CONNECT_RETRY: '0' });
  await assertRejects(() => embedTexts(cmd, ['x']), EmsUnavailableError, 'unreachable');
  assertEquals(await health(cmd), null);
  assertEquals(await transcribeSignature(cmd), null);
});

Deno.test('a refused connection is retried until EMS is back, for batch calls only', async () => {
  // Nothing listens until the stub starts a few seconds in — a restart, as the client sees it.
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const { cmd } = makeCmd({ CFG_EMS_URL: `http://127.0.0.1:${port}`, CFG_EMS_CONNECT_RETRY: '30' });

  // Interactive callers do not wait: a search box has a name half to answer from.
  await assertRejects(() => embedTexts(cmd, ['x'], { interactive: true }), EmsUnavailableError, 'unreachable');

  let stub: ReturnType<typeof startStubEms> | undefined;
  const later = setTimeout(() => {
    stub = Deno.serve(
      { port, hostname: '127.0.0.1', onListen: () => {} },
      () => Response.json({ ok: true, result: { embeddings: [[7]], dimension: 1 }, meta: {} }),
    ) as unknown as ReturnType<typeof startStubEms>;
  }, 3000);
  try {
    const started = Date.now();
    assertEquals((await embedTexts(cmd, ['x'])).vectors, [[7]]);
    assert(Date.now() - started >= 4000, 'the answer came from the retry, not the first attempt');
  } finally {
    clearTimeout(later);
    await (stub as unknown as Deno.HttpServer | undefined)?.shutdown();
  }
});

Deno.test('a batch request waits for a slow EMS, a caller with a timeout gives up at it', async () => {
  const stub = startStubEms({ ops: { 'text.embed': { result: { embeddings: [[1]], dimension: 1 } } }, delayMs: 400 });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    assertEquals((await embedTexts(cmd, ['x'])).vectors, [[1]]);
    await assertRejects(() => embedTexts(cmd, ['x'], { interactive: true, timeoutSeconds: 0.1 }), EmsUnavailableError, 'timed out after 0.1s');
  } finally {
    await stub.close();
  }
});

Deno.test('an interrupted command drops its request', async () => {
  const stub = startStubEms({ ops: { 'text.embed': { result: { embeddings: [[1]], dimension: 1 } } }, delayMs: 1500 });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url }, true);
    const started = Date.now();
    await assertRejects(() => embedTexts(cmd, ['x']), EmsUnavailableError, 'interrupted');
    assert(Date.now() - started < 1400, 'gave up before the answer would have arrived');
  } finally {
    await stub.close();
  }
});

Deno.test('health and the transcribe signature come from the system endpoints', async () => {
  const stub = startStubEms({
    health: { models: { whisper: { loaded: true, device: 'cuda' } }, degraded: [{ what: 'gpu', reason: 'sticky CUDA error' }] },
    capabilities: { signatures: { transcribe: 'whisper-large-v3:vad=0.2/400/500,nospeech=0.6,lang=auto,words=0' } },
  });
  try {
    const { cmd } = makeCmd({ CFG_EMS_URL: stub.url });
    const status = await health(cmd);
    assertEquals(status?.models.whisper, { loaded: true, device: 'cuda' });
    assertEquals(status?.degraded?.[0].what, 'gpu');
    assertEquals(await transcribeSignature(cmd), 'whisper-large-v3:vad=0.2/400/500,nospeech=0.6,lang=auto,words=0');
  } finally {
    await stub.close();
  }
});
