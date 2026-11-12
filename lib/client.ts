/**
 * Client for EMS (API v0) — the media service that holds every model and media tool EiN uses.
 *
 * HTTP/1.1 + JSON on the instance the command calls (instances.ts): the primary at `CFG_EMS_URL`,
 * with the bearer key `CFG_EMS_KEY` when that is the system's own EMS — the key is in no shell's
 * environment and goes nowhere else — or the one `CFG_EMS_INSTANCE` names. Every op takes the VFS path
 * of a file, which the request names by a name of its own in a directory `ems-files` serves EMS
 * for as long as the request runs (files.ts): EMS has no files of its own and reaches the request's
 * through that endpoint. With `CFG_EMS_FILES_ADDRESS` empty, or the service not serving yet, no
 * request that names a file goes: EMS counts as unavailable.
 *
 * Watches (`putWatch`, `watchEvents`, …) are EMS's live streams read for their faces: they name no
 * file, only the stream, and their events come as they happen. A watch's clips are videos EMS cut of
 * its stream, fetched from EMS by id (`clipBody`) and then dropped there (`dropClip`).
 *
 * Three outcomes matter to everything downstream, and they are kept distinct: EMS unreachable
 * (`EmsUnavailableError` — the step fails for its normal retry path), EMS answered with a
 * failure (`EmsError`, carrying the API's `code` and `permanent`), and a `null` result, which
 * some ops use for "nothing found" (no face inside the box, a span too short for a voiceprint).
 * There is no in-process fallback: the models are not in this image.
 */

import type { Command } from '@ein/client';
import type { EmsCapabilities, EmsDegradation } from '@ems/api';
import { STEP_EXIT_INPUT, STEP_EXIT_TEMPORARY } from '@ein/client';
import { forRequest } from './files.ts';
import { type EmsInstance, instanceName, otherInstanceNames, primaryInstance, readInstance, sameGenerations } from './instances.ts';

const API_MAJOR = 'v0';

const INTERRUPT_POLL_MS = 500;

// How long a batch call keeps trying to *connect* before it reports EMS absent. A restart of
// EMS — a rebuild, a memory recycle of its container, an operator's restart — refuses
// connections for tens of seconds, and the pipeline's retries are seconds apart, so without this
// every step in flight across that window would fail for good. A refused connection is retried
// every CONNECT_RETRY_MS until this budget is spent; an interactive caller gets no such patience
// and fails at once. Test instances have none either, and an address nothing answers on, unless a
// test points them at a stub (test/environment.json).
const DEFAULT_CONNECT_RETRY_SECONDS = 90;
const CONNECT_RETRY_MS = 5000;
// A second instance gets one retry: the work it gives back goes to another instance at once
// (`pipeline-worker --pass-on`), where waiting out a restart would hold it.
const OTHER_CONNECT_RETRY_SECONDS = 5;

/** A box in fractions of the display frame, origin top-left. */
export type Box = { x: number; y: number; width: number; height: number };

type FaceResult = {
  index: number;
  /** Fractions of `DetectFacesResult.frame`, the display frame detection ran in. */
  box: Box;
  confidence: number;
  embedding: number[];
  /** Fractions of the same frame. */
  landmarks?: number[][];
  /** Head pose in degrees in the same frame; all 0 faces the camera. Absent when the detector gives none. */
  pose?: FacePose;
};

/** `pitch` up/down, `yaw` left/right turn, `roll` tilt, in degrees. */
type FacePose = { pitch: number; yaw: number; roll: number };

/** `producer` names the models the vectors are from: vectors of two producers are not comparable. */
type DetectFacesResult = {
  frame: { width: number; height: number };
  faces: FaceResult[];
  producer: string;
};

export type TranscriptWord = { start: number; end: number; word: string };
export type TranscriptSegment = { start: number; end: number; text: string; words?: TranscriptWord[] };

export type TranscribeResult = {
  /** Every segment's text, joined. */
  text: string;
  /** False when the file carries no audio stream at all — `speech` is then false too. */
  audio: boolean;
  model: string;
  /**
   * Every setting that decided this output, as one string. `generations`' `transcribe` says what
   * a decode would write *now*; the two differing marks a transcript to redo.
   */
  signature: string;
  speech: boolean;
  segments: TranscriptSegment[];
  language?: string;
  languageProbability?: number;
  duration?: number;
};

/**
 * One speech turn. `speaker` is file-wide (`speaker_0`, `speaker_1`, … by first appearance),
 * or null for a turn EMS could attribute to nobody — too little voice under its label to be a
 * speaker, and unlike every one that is.
 */
type VoiceTurn = { start: number; end: number; speaker: string | null };
/**
 * One voice of a recording: its turns (`[start, end]` in seconds, in time order), how long it
 * spoke, and one voiceprint for all of it — the mean of its turns' voiceprints weighted by
 * length. Every speaker has one; a voice too brief to have one is not a speaker.
 */
export type VoiceSpeaker = { id: string; turns: [number, number][]; talkSeconds: number; vector: number[] };
/** `audio` is false when the file has no sound track at all — `speech` is then false too. */
type VoiceprintResult = { turns: VoiceTurn[]; speakers: VoiceSpeaker[]; speech: boolean; audio: boolean; duration: number; model: string };
/**
 * The visible face whose lips move with a speaker's voice: `score` 0..1, the face's `box` in
 * fractions of the display frame at `t` seconds, and its `embedding` to recognise, from the same
 * recogniser as `detectFaces`'.
 */
export type ActiveSpeaker = { id: string; score: number; t: number; box: Box; confidence: number; embedding: number[] };

/**
 * One face a video shows: when it is on screen (`[start, end]` in seconds), how many sampled
 * frames it was found in, and its clearest detection — `box`, `landmarks` and `pose` in the
 * display frame at `t` seconds. `embedding` is the normalized mean of its best detections, and
 * `track` its box in every sampled frame it was seen in, `[t, x, y, width, height]` in time order.
 */
type VideoFace = {
  appearances: [number, number][];
  detections: number;
  t: number;
  box: Box;
  confidence: number;
  landmarks?: number[][];
  pose?: FacePose;
  embedding: number[];
  track: [number, number, number, number, number][];
};

/** `interval` is the spacing EMS sampled at, longer than asked for a long video; `producer` as `detectFaces`'. */
export type DetectVideoFacesResult = {
  frame: { width: number; height: number };
  duration: number | null;
  interval: number;
  samples: number;
  faces: VideoFace[];
  producer: string;
};

/**
 * An SSCD descriptor is a unit vector, close to a copy's; a chromaprint is a recording's raw
 * sequence of 32-bit values, which matches another only once aligned.
 */
type Fingerprint =
  | { type: 'sscd-image' | 'sscd-video'; dimension: number; vector: number[]; label: string }
  | { type: 'chromaprint'; fingerprint: number[]; label: string };
/** A file's fingerprints, and what made them (`sscd_disc_mixup`, `ffmpeg/…`). */
export type FingerprintResult = { fingerprints: Fingerprint[]; producer: string };
type ExtractedText = { text: string; pages: number; method: string; wordCount: number };

export type { EmsDegradation } from '@ems/api';

/** What a model cost when it loaded, as EMS measures it. */
type EmsSize = { vram_mb?: number; ram_mb?: number; load_seconds?: number };

/** `GET /v0/health`, as EMS answers it. */
export type HealthResult = {
  ok: boolean;
  api: string;
  uptime: number;
  /**
   * Two views of the card: torch's accounting for this EMS's models (`vram_*`), and the whole
   * card as `nvidia-smi` sees it (`util_pct`, `mem_*`, `temp_c`), absent when EMS cannot run
   * `nvidia-smi`. Where the driver keeps samples, `util_pct` and the video decoder's and encoder's
   * `dec_pct` / `enc_pct` are means over the last 15 s.
   */
  gpu: {
    present: boolean;
    vram_allocated_mb?: number;
    vram_reserved_mb?: number;
    util_pct?: number;
    dec_pct?: number;
    enc_pct?: number;
    mem_used_mb?: number;
    mem_total_mb?: number;
    temp_c?: number;
    power_w?: number;
    power_limit_w?: number;
    driver?: string;
    name?: string;
    processes?: { pid: number; used_mb: number; worker?: string }[];
  };
  models: Record<string, { loaded: boolean; device?: string }>;
  worker: { running: boolean; restarts: number; query?: { running: boolean; restarts: number } };
  process?: {
    rss_mb?: number;
    max_rss_mb?: number;
    recycles?: number;
    uptime?: number;
    query?: { rss_mb?: number; max_rss_mb?: number; recycles?: number; uptime?: number };
  };
  degraded?: EmsDegradation[];
  queues?: Record<string, { running: number; waiting: number; limit: number; reserve: number }>;
  /** Every family the workers can load, resident or not. */
  families: Record<string, {
    model?: string | null;
    device?: string | null;
    purpose?: string;
    ops?: string[];
    measured?: Record<string, EmsSize>;
    pinned?: boolean;
    running?: boolean;
    waiting?: number;
    copies?: ({ key: string; state: 'loading' | 'loaded' | 'unloading'; since?: number | null; last_used?: number; device?: string; worker?: string } & EmsSize)[];
  }>;
  /** Every admission slot held or waited for, oldest first. */
  requests: { op: string; caller?: string; lane: string; interactive: boolean; queued: number; started?: number; family?: string }[];
  /** Each caller, by the name its key has: its weight, the slot-seconds it has used, and its requests running and waiting now. */
  callers?: Record<string, { weight: number; used_seconds: number; running: number; waiting: number }>;
  /** The machine EMS runs on (API 0.3.2): its total and available memory, and what EMS's container holds of it and may. */
  memory?: { total_mb: number; available_mb?: number; used_mb?: number; limit_mb?: number };
  /**
   * Who has the card (*3.4*): `busy` while batch model work arrives, `quiet` after `quiet_after`
   * seconds without any, when a card worker holds the search models that fit; `off` with no card.
   * `plan` is where each family runs in each mode.
   */
  card?: {
    mode: 'busy' | 'quiet' | 'switching' | 'off';
    since?: number;
    quiet_after?: number;
    last_batch?: number;
    batch_in_flight?: number;
    search_on_card?: string[];
    skipped?: Record<string, string>;
    plan?: Record<string, { busy: 'card' | 'cpu'; quiet: 'card' | 'cpu' | 'unloaded'; why?: string }>;
  };
  build?: { version?: string; commit?: string; date?: string };
  warnings?: string[];
};

/**
 * EMS answered with a failure. `permanent` says whether the same request can ever succeed;
 * `detail` is EMS's own message, for a caller that records it, where `message` names the op
 * and the code around it for a log.
 */
export class EmsError extends Error {
  constructor(readonly op: string, readonly code: string, readonly detail: string, readonly permanent: boolean, readonly status: number) {
    super(`ems: ${op}: ${detail} (${code})`);
  }
}

/** EMS could not be reached, did not answer in time, or answered with nothing usable. */
export class EmsUnavailableError extends Error {}

/** The caller stopped waiting: its own timeout, or the command was interrupted. Asking another instance would only wait again. */
class EmsGaveUpError extends EmsUnavailableError {}

/**
 * The EMS asked does not serve the op: `op_not_served` (its `EMS_OPS` leaves it out), or no route
 * for it at all. A fact about that instance, not the file, so it counts as EMS being away: another
 * instance, or this one set up again, does the work.
 */
export class EmsNotServedError extends EmsUnavailableError {}

/** EMS's codes that say the input is the problem: no retry can get past the same bytes. */
const INPUT_CODES = new Set(['undecodable', 'unsupported', 'not_found']);

/** EMS's codes that are the file's own fault: a step may record the file as unreadable for them. */
const FILE_FAULTS = new Set(['undecodable', 'unsupported', 'refused']);

/**
 * Whether EMS failed because of the file itself — bytes no decoder opens, a format nothing handles,
 * work EMS refuses for this source — so that no run, on any instance, gets further with it. Every
 * other failure, a permanent one included, says nothing about the file.
 */
export const isFileFault = (error: unknown): error is EmsError => error instanceof EmsError && error.permanent && FILE_FAULTS.has(error.code);

/**
 * The exit code a pipeline step's bin ends with when an EMS call failed: whether the failure is
 * EMS's moment (`STEP_EXIT_TEMPORARY`, retried without spending an attempt), the input's
 * (`STEP_EXIT_INPUT`, never retried), or the step's own (1). Anything not an EMS failure is 1.
 */
export const stepExitCode = (error: unknown): number => {
  if (error instanceof EmsUnavailableError) return STEP_EXIT_TEMPORARY;
  if (!(error instanceof EmsError)) return 1;
  if (error.code === 'deadline_exceeded') return STEP_EXIT_TEMPORARY;
  if (error.permanent && INPUT_CODES.has(error.code)) return STEP_EXIT_INPUT;
  return 1;
};

type CallOptions = {
  timeoutSeconds?: number;
  priority?: 'interactive';
  onProgress?: (phase: string) => void | Promise<void>;
  /**
   * Ask EMS to stream, so the command can say how far the op has come (`cmd.progress`) while it
   * runs. Set by the ops that take minutes; `onProgress` streams too.
   */
  stream?: boolean;
};

/**
 * The instance `cmd` calls: the one `CFG_EMS_INSTANCE` names, or the primary. A name with no
 * instance behind it is EMS being away, so the step waits rather than failing.
 */
export const emsInstance = async (cmd: Pick<Command, 'sys' | 'env'>): Promise<EmsInstance> => {
  const name = instanceName(cmd);
  const instance = await readInstance(cmd, name);
  if (!instance) throw new EmsUnavailableError(`ems: no instance called ${name}`);
  return instance;
};

/** A request's headers, with the instance's key when it has one. */
const headers = (instance: EmsInstance): Record<string, string> => ({
  'content-type': 'application/json',
  ...(instance.key ? { authorization: `Bearer ${instance.key}` } : {}),
});

/** `ems` for the primary and `ems <name>` for another, as messages name the one that answered. */
const who = (instance: EmsInstance): string => instance.primary ? 'ems' : `ems ${instance.name}`;

/** A failure to reach EMS at all — before any byte of a request was answered. */
class ConnectError extends Error {}

/**
 * A fetch that ends when the command is interrupted, or after `waitMs` when the caller set one.
 *
 * Closing the connection is EMS's whole cancellation API — it kills the tool or discards the
 * queued model request — so a killed pipeline step must actually close it. `cmd.interrupted` is
 * polled rather than `cmd.onInterrupt` registered, because a bin owns that single handler.
 */
const fetchOnce = async (cmd: Command, op: string, url: string, init: RequestInit, waitMs: number | undefined): Promise<Response> => {
  const controller = new AbortController();
  let why: 'timeout' | 'interrupted' | undefined;
  const timer = waitMs === undefined ? undefined : setTimeout(() => {
    why = 'timeout';
    controller.abort();
  }, waitMs);
  const poll = setInterval(() => {
    if (cmd.interrupted) {
      why = 'interrupted';
      controller.abort();
    }
  }, INTERRUPT_POLL_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (why === 'timeout') throw new EmsGaveUpError(`ems: ${op} timed out after ${waitMs! / 1000}s`);
    if (why === 'interrupted') throw new EmsGaveUpError(`ems: ${op} interrupted`);
    throw new ConnectError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
};

const connectRetryMs = (cmd: Command, instance: EmsInstance): number => {
  const seconds = parseFloat(cmd.env.CFG_EMS_CONNECT_RETRY || '');
  const patience = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_CONNECT_RETRY_SECONDS;
  return (instance.primary ? patience : Math.min(patience, OTHER_CONNECT_RETRY_SECONDS)) * 1000;
};

/**
 * `fetchOnce`, retrying a refused connection for a while — see DEFAULT_CONNECT_RETRY_SECONDS.
 * The retry budget is separate from `waitMs`, which bounds one answered request.
 */
const fetchInterruptible = async (cmd: Command, op: string, url: string, init: RequestInit, waitMs: number | undefined, patienceMs: number): Promise<Response> => {
  const deadline = Date.now() + patienceMs;
  let attempt = 0;
  while (true) {
    try {
      return await fetchOnce(cmd, op, url, init, waitMs);
    } catch (error) {
      if (!(error instanceof ConnectError)) throw error;
      if (Date.now() + CONNECT_RETRY_MS > deadline || cmd.interrupted) {
        throw new EmsUnavailableError(`ems: ${op} unreachable: ${error.message}${attempt ? ` (after ${attempt} retries)` : ''}`);
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
};

type Envelope = { ok?: boolean; result?: unknown; error?: { code?: string; message?: string; permanent?: boolean }; meta?: Record<string, unknown> };
type Answer = { result: unknown; meta?: Record<string, unknown> };

/**
 * Read EMS's SSE form through its terminal result/error event. Each progress event's phase goes to
 * `onProgress`, and its `fraction`, how much of the op is done, to `cmd.progress`.
 */
const streamedEnvelope = async (cmd: Command, response: Response, onProgress: CallOptions['onProgress']): Promise<Envelope> => {
  if (!response.body) throw new EmsUnavailableError('ems: streamed request answered with no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal: Envelope | undefined;

  const consume = async (block: string) => {
    let event = '';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!event || data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      throw new EmsUnavailableError(`ems: streamed request returned invalid ${event} data`);
    }
    if (event === 'progress') {
      const { phase, fraction } = parsed && typeof parsed === 'object' ? parsed as { phase?: unknown; fraction?: unknown } : {};
      if (typeof phase === 'string') await onProgress?.(phase);
      if (typeof fraction === 'number') cmd.progress(fraction);
    } else if (event === 'result' || event === 'error') {
      terminal = parsed as Envelope;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) await consume(block);
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
  if (!terminal) throw new EmsUnavailableError('ems: streamed request ended without a result');
  return terminal;
};

/**
 * One op on one instance. Every failure is one of the two error classes; a `busy`/loading EMS
 * counts as absent.
 *
 * A request waits for its answer however long EMS takes, unless the caller names its own
 * patience (`timeoutSeconds`). Only a caller a person is waiting on does: batch work that is
 * slow is working, and giving up on it only means doing it again (ein/core#358).
 */
const requestOn = async (cmd: Command, instance: EmsInstance, op: string, body: Record<string, unknown>, opts: CallOptions): Promise<Answer> => {
  const ems = who(instance);
  const waitMs = opts.timeoutSeconds === undefined ? undefined : opts.timeoutSeconds * 1000;
  const options: Record<string, unknown> = {};
  if (opts.priority === 'interactive') options.priority = 'interactive';
  // An absolute deadline lets EMS discard a queued request once nobody is waiting for it: a
  // search that gives up should not leave its embedding queued.
  if (waitMs !== undefined) options.deadline = (Date.now() + waitMs) / 1000;
  const payload = Object.keys(options).length > 0 ? { ...body, options } : body;
  const stream = opts.stream || opts.onProgress !== undefined;
  // EMS reaches the request's files through ems-files for as long as the answer takes, and sends
  // back what it wrote before it answers; while the service does not serve (it restarts, or
  // CFG_EMS_FILES_ADDRESS is empty), EMS could open none of them, so the request waits.
  const files = await forRequest(cmd, instance.url, payload);
  if (!files) {
    const why = cmd.env.CFG_EMS_FILES_ADDRESS ? 'ems-files is not serving' : 'CFG_EMS_FILES_ADDRESS is empty';
    throw new EmsUnavailableError(`${ems}: ${op}: ${why}`);
  }

  let response: Response;
  let envelope: Envelope;
  try {
    response = await fetchInterruptible(
      cmd,
      op,
      `${instance.url}/${API_MAJOR}/${op.replace('.', '/')}`,
      {
        method: 'POST',
        headers: { ...headers(instance), ...files.headers, ...(stream ? { accept: 'text/event-stream' } : {}) },
        body: JSON.stringify(files.body),
      },
      waitMs,
      opts.priority === 'interactive' ? 0 : connectRetryMs(cmd, instance),
    );
    try {
      envelope = stream ? await streamedEnvelope(cmd, response, opts.onProgress) : await response.json() as Envelope;
    } catch (error) {
      if (error instanceof EmsUnavailableError) throw error;
      throw new EmsUnavailableError(`${ems}: ${op} answered ${response.status} with no usable body`);
    }
  } finally {
    void files.release();
  }
  if (!envelope.ok) {
    const code = envelope.error?.code ?? `http_${response.status}`;
    const message = envelope.error?.message ?? `HTTP ${response.status}`;
    // A full queue, a worker still loading or a file endpoint EMS could not reach is, for a caller,
    // the same as no EMS at all: the step fails now and the pool tries again later.
    if (code === 'busy' || code === 'model_unavailable' || code === 'files_unavailable') throw new EmsUnavailableError(`${ems}: ${op} ${message} (${code})`);
    // An EMS that predates EMS_OPS has no route for an op it lacks, and answers 404 without an envelope.
    if (code === 'op_not_served' || code === 'http_404') throw new EmsNotServedError(`${ems}: ${op} ${message} (${code})`);
    // What a second instance refuses within its own budget, the primary may not: only the
    // primary's refusal is the source's (`generations`' `cpuBudget` is the primary's).
    if (code === 'refused' && !instance.primary) throw new EmsUnavailableError(`${ems}: ${op} ${message} (${code})`);
    throw new EmsError(op, code, message, envelope.error?.permanent === true, response.status);
  }
  return { result: envelope.result, meta: envelope.meta };
};

/**
 * One op, on the instance the command calls. A search someone waits on (`interactive`) that the
 * primary cannot answer goes to the first other instance that serves the op and stamps it as the
 * primary does, so a query's vector is comparable with the stored ones.
 */
const request = async (cmd: Command, op: string, body: Record<string, unknown>, opts: CallOptions = {}): Promise<Answer> => {
  const instance = await emsInstance(cmd);
  try {
    return await requestOn(cmd, instance, op, body, opts);
  } catch (error) {
    if (opts.priority !== 'interactive' || !instance.primary || !(error instanceof EmsUnavailableError) || error instanceof EmsGaveUpError) throw error;
    const other = await standIn(cmd, op);
    if (!other) throw error;
    return await requestOn(cmd, other, op, body, opts);
  }
};

/**
 * The first other instance that answers, serves `op` and stamps it as the primary did when it last
 * said: none when there is no other, or the primary has not answered since this process started.
 */
const standIn = async (cmd: Command, op: string): Promise<EmsInstance | undefined> => {
  const primary = lastPrimaryCapabilities();
  if (!primary) return undefined;
  for (const name of await otherInstanceNames(cmd)) {
    const instance = await readInstance(cmd, name);
    if (!instance) continue;
    const capabilities = await capabilitiesOf(cmd, instance, STAND_IN_WAIT_SECONDS);
    if (capabilities && sameGenerations(primary, capabilities, [op])) return instance;
  }
  return undefined;
};

/** How long a stand-in's capabilities may take: a person is waiting. */
const STAND_IN_WAIT_SECONDS = 2;

const call = async (cmd: Command, op: string, body: Record<string, unknown>, opts: CallOptions = {}): Promise<unknown> => (await request(cmd, op, body, opts)).result;

const producerOf = (answer: Answer): string => (typeof answer.meta?.producer === 'string' ? answer.meta.producer : '');

const fileRef = (path: string, angle = 0, mirror = false): Record<string, unknown> => ({ path, angle, mirror });

/**
 * Transcribe the sound of any file with whisper. `speech` is false when nothing was recognised
 * and `audio` false when there was no sound to listen to.
 *
 * EMS extracts the audio itself (once per file, cached across the speech ops), so this takes
 * the media file. `CFG_WHISPER_LANGUAGE`, `CFG_WHISPER_VAD_MIN_SILENCE_MS` and
 * `CFG_WHISPER_WORD_TIMESTAMPS` are forwarded when set; EMS's own configuration decides
 * otherwise.
 */
export const transcribe = async (cmd: Command, path: string): Promise<TranscribeResult> => {
  const body: Record<string, unknown> = { file: fileRef(path) };
  if (cmd.env.CFG_WHISPER_LANGUAGE) body.language = cmd.env.CFG_WHISPER_LANGUAGE;
  const silence = Number(cmd.env.CFG_WHISPER_VAD_MIN_SILENCE_MS);
  if (cmd.env.CFG_WHISPER_VAD_MIN_SILENCE_MS && Number.isFinite(silence)) body.vad = { min_silence_ms: silence };
  if (cmd.env.CFG_WHISPER_WORD_TIMESTAMPS) body.word_timestamps = cmd.env.CFG_WHISPER_WORD_TIMESTAMPS === '1';
  const raw = await request(cmd, 'speech.transcribe', body);
  const result = raw.result as {
    text: string;
    audio?: boolean;
    speech: boolean;
    segments?: TranscriptSegment[];
    language?: string;
    language_probability?: number;
    duration?: number;
  };
  const producer = producerOf(raw);
  return {
    text: result.text,
    audio: result.audio !== false,
    // The producer is the transcribe signature (`whisper-large-v3:vad=…`); its model half is
    // what `describedBy` and the provenance strings want.
    model: producer.split(':', 1)[0],
    signature: producer,
    speech: result.speech,
    segments: result.segments ?? [],
    ...(result.language ? { language: result.language } : {}),
    ...(result.language_probability !== undefined ? { languageProbability: result.language_probability } : {}),
    ...(result.duration !== undefined ? { duration: result.duration } : {}),
  };
};

/**
 * How long an interactive caller waits for a query embed. A warm embedder answers in well under
 * two seconds, which is what a search aims for; past that the answer is still worth having, so
 * this only bounds a wedged service. The same instant goes to EMS as the request's deadline, and
 * EMS drops the request rather than run it once it passes or the caller hangs up.
 */
const INTERACTIVE_TIMEOUT_SECONDS = 60;

type EmbedTextOptions = {
  /** Ahead of batch work in EMS's queues, waiting at most INTERACTIVE_TIMEOUT_SECONDS. */
  interactive?: boolean;
  /** With `interactive`: how long to wait instead of INTERACTIVE_TIMEOUT_SECONDS. */
  timeoutSeconds?: number;
};

type EmbedTextsOptions = EmbedTextOptions & {
  /** A search query, or the text it should find (the default). The current embedder embeds them differently. */
  role?: 'query' | 'document';
};

/**
 * Embed texts with EMS's text embedder (`text.embed`), in order, and name the model that made
 * them — a stored vector's space is its producer. A text over the embedder's token limit is
 * refused (`invalid_request`), never cut: the caller chunks.
 */
export const embedTexts = async (cmd: Command, texts: string[], opts: EmbedTextsOptions = {}): Promise<{ vectors: number[][]; producer: string }> => {
  const raw = await request(
    cmd,
    'text.embed',
    { texts, model: 'current', role: opts.role ?? 'document' },
    opts.interactive ? { timeoutSeconds: opts.timeoutSeconds ?? INTERACTIVE_TIMEOUT_SECONDS, priority: 'interactive' } : {},
  );
  const vectors = (raw.result as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new EmsUnavailableError(`ems: text.embed answered ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${texts.length} texts`);
  }
  return { vectors: vectors as number[][], producer: producerOf(raw) };
};

/**
 * Detect faces: boxes, landmarks and 512-dim embeddings, all as fractions of the display frame
 * named by `angle`/`mirror` — the file node's rotation, never the EXIF tag's — and the models
 * that made them.
 */
export const detectFaces = async (cmd: Command, path: string, angle = 0, mirror = false): Promise<DetectFacesResult> => {
  const raw = await request(cmd, 'faces.detect', { file: fileRef(path, angle, mirror) });
  const result = raw.result as {
    frame: { width: number; height: number };
    faces: { box: Box; confidence: number; embedding: number[]; landmarks?: number[][]; pose?: FacePose }[];
  };
  return { frame: result.frame, faces: result.faces.map((face, index) => ({ index, ...face })), producer: producerOf(raw) };
};

/**
 * Who speaks when in a recording: its voices, each with its turns and one voiceprint, and every
 * turn with the voice it belongs to.
 *
 * One request for the whole file, however long: EMS diarizes it in whatever windows its card
 * allows, embeds every turn from one decode of the sound, and stitches the windows back into
 * file-wide speakers before answering — the window is its hardware's business, not ours.
 * `speech` is false when nobody talks. `model` names both models, `<diarizer>+<embedder>`.
 */
export const voiceprint = async (cmd: Command, path: string, opts: Pick<CallOptions, 'onProgress'> = {}): Promise<VoiceprintResult> => {
  const raw = await request(cmd, 'speech.voiceprint', { file: fileRef(path) }, opts);
  const result = raw.result as {
    speech: boolean;
    audio?: boolean;
    duration: number;
    turns: { start: number; end: number; speaker: string | null }[];
    speakers?: { id: string; turns: [number, number][]; talkSeconds: number; vector: number[] }[];
  };
  return {
    turns: result.turns.map((t) => ({ start: t.start, end: t.end, speaker: t.speaker ?? null })),
    speakers: (result.speakers ?? []).map((s) => ({ id: s.id, turns: s.turns, talkSeconds: s.talkSeconds, vector: s.vector })),
    speech: result.speech,
    audio: result.audio ?? result.speech,
    duration: result.duration,
    model: producerOf(raw),
  };
};

/**
 * Per speaker of a video, the visible face whose lips move with its voice, in one request: EMS
 * decodes the video once, scoring a stretch of each speaker's longest turns. A speaker with no
 * face to score is left out; how high a score counts is the caller's call.
 */
export const activeSpeakers = async (
  cmd: Command,
  videoPath: string,
  angle: number,
  mirror: boolean,
  speakers: { id: string; turns: [number, number][] }[],
  opts: Pick<CallOptions, 'onProgress'> = {},
): Promise<ActiveSpeaker[]> => {
  const raw = await request(cmd, 'speech.active_speakers', { file: fileRef(videoPath, angle, mirror), speakers }, opts);
  return (raw.result as { speakers: ActiveSpeaker[] }).speakers;
};

type DetectVideoFacesOptions = Pick<CallOptions, 'onProgress'> & {
  /** Seconds between the frames looked at; EMS's default is 1. */
  interval?: number;
  /** Smallest face kept, as a fraction of the frame's shorter side. */
  minSize?: number;
  /** Lowest detection confidence kept. */
  minConfidence?: number;
};

/**
 * The faces a video shows and when, in one request: EMS samples the video once, follows each
 * face through it and groups the sightings into one face per person seen — two faces on screen
 * together are never one. The boxes are fractions of the display frame `angle`/`mirror` name.
 */
export const detectVideoFaces = async (
  cmd: Command,
  path: string,
  angle: number,
  mirror: boolean,
  opts: DetectVideoFacesOptions = {},
): Promise<DetectVideoFacesResult> => {
  const body: Record<string, unknown> = { file: fileRef(path, angle, mirror) };
  if (opts.interval !== undefined) body.interval = opts.interval;
  if (opts.minSize !== undefined) body.min_size = opts.minSize;
  if (opts.minConfidence !== undefined) body.min_confidence = opts.minConfidence;
  const raw = await request(cmd, 'faces.detect_video', body, { onProgress: opts.onProgress, stream: true });
  return { ...(raw.result as Omit<DetectVideoFacesResult, 'producer'>), producer: producerOf(raw) };
};

type EmbedImageOptions = EmbedTextOptions & {
  angle?: number;
  mirror?: boolean;
  mimetype?: string;
};

export type EmbedImageResult = {
  /** The image embedder that ran (`ViT-SO400M-16-SigLIP2-384__webli`): stored as `embeddedBy`. */
  producer: string;
  dimension: number;
  /** A photo's vector. */
  embedding?: number[];
  /** A video's, one per keyframe, with its second in the clip. */
  frames?: { at: number; embedding: number[] }[];
};

/**
 * A picture's vector in the image-text space (SigLIP2), for search by what is in it. Normalized; compare by cosine against `embedImageText`, or against another
 * picture's. `interactive` for a search someone is waiting on, as with `embedImageText`.
 */
export const embedImage = async (cmd: Command, path: string, opts: EmbedImageOptions = {}): Promise<EmbedImageResult> => {
  const raw = await request(
    cmd,
    'vision.embed',
    { file: { path: path, angle: opts.angle ?? 0, mirror: opts.mirror ?? false, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) } },
    opts.interactive ? { timeoutSeconds: opts.timeoutSeconds ?? INTERACTIVE_TIMEOUT_SECONDS, priority: 'interactive' } : {},
  );
  const result = raw.result as { embedding?: number[]; frames?: { at: number; embedding: number[] }[]; dimension: number };
  return {
    producer: producerOf(raw),
    dimension: result.dimension,
    ...(result.embedding ? { embedding: result.embedding } : {}),
    ...(result.frames ? { frames: result.frames } : {}),
  };
};

/** Search text as a vector in the pictures' space, and the model that made it. */
export const embedImageText = async (cmd: Command, text: string, opts: EmbedTextOptions = {}): Promise<{ embedding: number[]; producer: string }> => {
  const raw = await request(
    cmd,
    'vision.embed_text',
    { text },
    opts.interactive ? { timeoutSeconds: opts.timeoutSeconds ?? INTERACTIVE_TIMEOUT_SECONDS, priority: 'interactive' } : {},
  );
  return { embedding: (raw.result as { embedding: number[] }).embedding, producer: producerOf(raw) };
};

export type RenditionFit = 'contain' | 'cover' | 'fill';
type RenditionFormat = 'avif' | 'webp' | 'jpeg' | 'png';

/**
 * One output of `image.renditions` (and of `video.poster` / `audio.waveform`, which fit their
 * one picture the same way). `output` is the VFS path of the node whose bytes EMS writes — the
 * caller creates it first and syncs it afterwards; EMS never learns what the node is called.
 */
export type RenditionTarget = {
  output: string;
  format?: RenditionFormat;
  quality?: number;
  /** A bounding box in pixels of the display frame; either side may be omitted. */
  box?: { width?: number; height?: number };
  /** `contain` (default) never upscales; `cover` fills the box exactly and does; `fill` stretches. */
  fit?: RenditionFit;
  /** Cut this display-frame fraction out first, grown by `pad` of its own size on each side. */
  crop?: Box;
  pad?: number;
};

type Rendition = { path: string; width: number; height: number; bytes: number };
type RenditionsResult = { frame: { width: number; height: number }; targets: Rendition[]; producer: string };

type RenditionsOptions = { angle?: number; mirror?: boolean; mimetype?: string; targets: RenditionTarget[] };

const targetBodies = (targets: RenditionTarget[], outputs: string[]): Record<string, unknown>[] =>
  targets.map((target, index) => ({
    output: { path: outputs[index], ...(target.format ? { format: target.format } : {}), ...(target.quality !== undefined ? { quality: target.quality } : {}) },
    ...(target.box ? { box: target.box } : {}),
    ...(target.fit ? { fit: target.fit } : {}),
    ...(target.crop ? { crop: target.crop } : {}),
    ...(target.pad !== undefined ? { pad: target.pad } : {}),
  }));

/** Map the paths in EMS's answer back to the VFS paths the targets named. */
const renditionsOf = (raw: { frame?: { width: number; height: number }; targets: Rendition[] }, targets: RenditionTarget[], answer: Answer): RenditionsResult => ({
  frame: raw.frame ?? { width: 0, height: 0 },
  targets: raw.targets.map((rendition, index) => ({ ...rendition, path: targets[index].output })),
  producer: producerOf(answer),
});

/** The most targets EMS takes in one `image.renditions` call; a caller with more splits them. */
export const MAX_RENDITION_TARGETS = 32;

/**
 * Sized copies of one image, from one decode — the derivative ladder, and a face crop when a
 * target carries `crop`. Every output is written or none is. At most `MAX_RENDITION_TARGETS`.
 */
export const renditions = async (cmd: Command, path: string, opts: RenditionsOptions): Promise<RenditionsResult> => {
  const outputs = opts.targets.map((t) => t.output);
  const body = {
    file: { ...fileRef(path, opts.angle ?? 0, opts.mirror ?? false), ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) },
    targets: targetBodies(opts.targets, outputs),
  };
  const answer = await request(cmd, 'image.renditions', body);
  return renditionsOf(answer.result as { frame: { width: number; height: number }; targets: Rendition[] }, opts.targets, answer);
};

/**
 * How a restoration op is called: `interactive` when a person waits for it, which puts it ahead of
 * batch work in its model's queue without giving up on it, since a large scan takes minutes.
 */
export type RestoreCallOptions = { interactive?: boolean; onProgress?: (phase: string) => void | Promise<void> };

/**
 * A picture a restoration op wrote into `output`, at its source's own depth and channels, without
 * metadata, as stored (no turn applied).
 */
type RestoredPicture = { path: string; width: number; height: number; channels: number; depth: number; bytes: number; producer: string };

type RestoreOutput = { output: string; format?: 'png' | 'tiff' };

const restoreCall = (opts: RestoreCallOptions): CallOptions => ({
  ...(opts.interactive ? { priority: 'interactive' as const } : {}),
  ...(opts.onProgress ? { onProgress: opts.onProgress } : { stream: true }),
});

const restored = (answer: Answer, output: string): RestoredPicture => {
  const raw = answer.result as Omit<RestoredPicture, 'producer'>;
  return { path: output, width: raw.width, height: raw.height, channels: raw.channels, depth: raw.depth, bytes: raw.bytes, producer: producerOf(answer) };
};

const outputBody = (opts: RestoreOutput): Record<string, unknown> => ({ path: opts.output, ...(opts.format ? { format: opts.format } : {}) });

/**
 * A faded colour print's colours back (`image.unfade`): each channel stretched between its own
 * black and white point, then its most neutral tones balanced to grey. Deterministic, no model.
 */
export const unfade = async (
  cmd: Command,
  path: string,
  opts: RestoreOutput & { clip?: number; balance?: boolean; strength?: number },
  call: RestoreCallOptions = {},
): Promise<RestoredPicture & { levels: [number, number][]; gammas: number[] }> => {
  const body: Record<string, unknown> = { file: fileRef(path), output: outputBody(opts) };
  if (opts.clip !== undefined) body.clip = opts.clip;
  if (opts.balance !== undefined) body.balance = opts.balance;
  if (opts.strength !== undefined) body.strength = opts.strength;
  const answer = await request(cmd, 'image.unfade', body, restoreCall(call));
  const raw = answer.result as { levels: [number, number][]; gammas: number[] };
  return { ...restored(answer, opts.output), levels: raw.levels, gammas: raw.gammas };
};

/** The dust and scratches of a scanned print (`image.defects`): a one-channel PNG mask, 255 where marked. */
type DefectsResult = { path: string; width: number; height: number; marked: number; fraction: number; producer: string };

/**
 * Where a scanned print is damaged, as the mask `inpaint` takes, written into `output` (a PNG).
 * `dark` looks for damage darker than the picture too. A guess: wrong where the picture itself
 * has thin light or dark lines.
 */
export const findDefects = async (
  cmd: Command,
  path: string,
  opts: { output: string; scale?: number; threshold?: number; dark?: boolean },
  call: RestoreCallOptions = {},
): Promise<DefectsResult> => {
  const body: Record<string, unknown> = { file: fileRef(path), output: { path: opts.output } };
  if (opts.scale !== undefined) body.scale = opts.scale;
  if (opts.threshold !== undefined) body.threshold = opts.threshold;
  if (opts.dark !== undefined) body.dark = opts.dark;
  const answer = await request(cmd, 'image.defects', body, restoreCall(call));
  const raw = answer.result as Omit<DefectsResult, 'path' | 'producer'>;
  return { path: opts.output, width: raw.width, height: raw.height, marked: raw.marked, fraction: raw.fraction, producer: producerOf(answer) };
};

/**
 * The pixels `mask` marks filled from what surrounds them (`image.inpaint`); every other pixel is
 * the picture's. `ns` and `telea` (OpenCV) suit dust and thin scratches, `lama` creases and tears.
 */
export const inpaint = async (
  cmd: Command,
  path: string,
  opts: RestoreOutput & { mask: string; method?: 'telea' | 'ns' | 'lama'; radius?: number },
  call: RestoreCallOptions = {},
): Promise<RestoredPicture & { filled: number }> => {
  const body: Record<string, unknown> = { file: fileRef(path), mask: { path: opts.mask }, output: outputBody(opts) };
  if (opts.method) body.method = opts.method;
  if (opts.radius !== undefined) body.radius = opts.radius;
  const answer = await request(cmd, 'image.inpaint', body, restoreCall(call));
  return { ...restored(answer, opts.output), filled: (answer.result as { filled: number }).filled };
};

/** A picture with less grain and noise (`image.denoise`, SCUNet); `strength` blends with the picture. */
export const denoise = async (
  cmd: Command,
  path: string,
  opts: RestoreOutput & { noise?: '15' | '25' | 'real'; strength?: number },
  call: RestoreCallOptions = {},
): Promise<RestoredPicture> => {
  const body: Record<string, unknown> = { file: fileRef(path), output: outputBody(opts) };
  if (opts.noise) body.noise = opts.noise;
  if (opts.strength !== undefined) body.strength = opts.strength;
  return restored(await request(cmd, 'image.denoise', body, restoreCall(call)), opts.output);
};

/** One edit of a picture, as an XMP history event: `edited`, when (ISO 8601), by what and how. */
export type PictureEdit = { action: string; when?: string; softwareAgent?: string; parameters?: string; changed?: string };

type CopyTagsOptions = {
  /** The file whose metadata is copied: EXIF, GPS, XMP, IPTC and the colour profile, less its orientation and thumbnail. */
  source: string;
  /** Written in `path`'s format, so its name ends in `path`'s extension. */
  output: string;
  /** `path`'s turn, written as its EXIF Orientation. */
  angle?: number;
  mirror?: boolean;
  /** Appended to the source's XMP history. */
  history?: PictureEdit[];
  /** A term of IPTC's digital source type vocabulary, such as `compositeWithTrainedAlgorithmicMedia`. */
  digitalSourceType?: string;
};

/**
 * `path` with the metadata of another file (`image.copy_tags`), written into `output`: for a
 * picture made from it, whose pixels are new but whose date, camera and place are the other's.
 * Its pixels are not touched.
 */
export const copyTags = async (
  cmd: Command,
  path: string,
  opts: CopyTagsOptions,
  call: RestoreCallOptions = {},
): Promise<{ path: string; bytes: number; producer: string }> => {
  const body: Record<string, unknown> = { file: fileRef(path, opts.angle ?? 0, opts.mirror ?? false), source: { path: opts.source }, output: { path: opts.output } };
  if (opts.history?.length) {
    body.history = opts.history.map((edit) => ({
      action: edit.action,
      ...(edit.when ? { when: edit.when } : {}),
      ...(edit.softwareAgent ? { software_agent: edit.softwareAgent } : {}),
      ...(edit.parameters ? { parameters: edit.parameters } : {}),
      ...(edit.changed ? { changed: edit.changed } : {}),
    }));
  }
  if (opts.digitalSourceType) body.digital_source_type = opts.digitalSourceType;
  const answer = await request(cmd, 'image.copy_tags', body, restoreCall(call));
  return { path: opts.output, bytes: (answer.result as { bytes: number }).bytes, producer: producerOf(answer) };
};

type PosterOptions = RenditionsOptions & {
  /** Seconds into the clip; EMS defaults to 1, past the black leader most cameras record. */
  at?: number;
  deinterlace?: boolean;
  /** For a poster that stands for the whole video: a blank frame at `at` gives way to a later one that shows something. */
  skipBlank?: boolean;
};

/** One frame of a video, fitted into rendition targets like a photo, and the second it was taken at. */
export const poster = async (cmd: Command, path: string, opts: PosterOptions): Promise<RenditionsResult & { t: number }> => {
  const outputs = opts.targets.map((t) => t.output);
  const body: Record<string, unknown> = {
    file: { ...fileRef(path, opts.angle ?? 0, opts.mirror ?? false), ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) },
    targets: targetBodies(opts.targets, outputs),
  };
  if (opts.at !== undefined) body.at = opts.at;
  if (opts.deinterlace) body.deinterlace = true;
  if (opts.skipBlank) body.skip_blank = true;
  const answer = await request(cmd, 'video.poster', body);
  const raw = answer.result as { frame: { width: number; height: number }; targets: Rendition[]; t: number };
  return { ...renditionsOf(raw, opts.targets, answer), t: raw.t };
};

type WaveformStyle = { foreground?: string; background?: string; baseline?: string | null; aspect?: number };
type WaveformOptions = { mimetype?: string; targets: RenditionTarget[]; style?: WaveformStyle };

/** A rendered waveform picture of a recording, per target: square for `cover`, a banner otherwise. */
export const waveform = async (cmd: Command, path: string, opts: WaveformOptions): Promise<RenditionsResult> => {
  const outputs = opts.targets.map((t) => t.output);
  const body: Record<string, unknown> = {
    file: { path: path, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) },
    targets: targetBodies(opts.targets, outputs),
  };
  if (opts.style) body.style = opts.style;
  const answer = await request(cmd, 'audio.waveform', body);
  return renditionsOf(answer.result as { targets: Rendition[] }, opts.targets, answer);
};

type VideoTranscodeOptions = {
  /** VFS path of the node whose bytes EMS writes (the caller creates it first and syncs it after). */
  output: string;
  angle?: number;
  mirror?: boolean;
  mimetype?: string;
  /** A bounding box; the picture is fitted inside and never upscaled. */
  box?: { width?: number; height?: number };
  /** AV1 quality (0–63, lower is better) and SVT-AV1 speed (0–13); EMS maps them onto NVENC. */
  quality?: number;
  speed?: number;
  deinterlace?: boolean;
  /** AAC bitrate, or `null` to drop the sound. Absent means EMS's default. */
  audioBitrate?: string | null;
  clip?: { start?: number; duration?: number };
  /** ffmpeg's name for the source's picture codec, off the node, so EMS can skip a doomed GPU decode. */
  sourceCodec?: string;
};

type VideoTranscodeResult = {
  path: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  bytes: number;
  videoCodec: string | null;
  audioCodec: string | null;
  /** `ffmpeg/<version>/<encoder>/<chain>` — which stage of EMS's ladder made it. */
  producer: string;
};

/**
 * The web rendition of a video, written by EMS into `output`.
 *
 * EMS runs the whole ladder (everything in VRAM, a CPU decode into NVENC, the CPU alone), the
 * projected CPU-decode budget and the windowed encode; a source it cannot make the rendition
 * of at its budget comes back as an `EmsError` with code `refused`, permanent — see
 * `generations`' `cpuBudget` for what to record beside it.
 */
export const transcodeVideo = async (cmd: Command, path: string, opts: VideoTranscodeOptions): Promise<VideoTranscodeResult> => {
  const body: Record<string, unknown> = {
    file: { ...fileRef(path, opts.angle ?? 0, opts.mirror ?? false), ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) },
    output: { path: opts.output, format: 'mp4' },
    video: {
      ...(opts.box ? { box: opts.box } : {}),
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
      ...(opts.deinterlace ? { deinterlace: true } : {}),
    },
  };
  if (opts.audioBitrate === null) body.audio = null;
  else if (opts.audioBitrate) body.audio = { bitrate: opts.audioBitrate };
  if (opts.clip) body.clip = opts.clip;
  if (opts.sourceCodec) body.hints = { source_codec: opts.sourceCodec };
  const answer = await request(cmd, 'video.transcode', body);
  const raw = answer.result as {
    width: number | null;
    height: number | null;
    duration: number | null;
    bytes: number;
    video_codec: string | null;
    audio_codec: string | null;
  };
  return {
    path: opts.output,
    width: raw.width,
    height: raw.height,
    duration: raw.duration,
    bytes: raw.bytes,
    videoCodec: raw.video_codec,
    audioCodec: raw.audio_codec,
    producer: producerOf(answer),
  };
};

type StoryboardOptions = {
  /** VFS path of the node whose bytes EMS writes (the caller creates it first and syncs it after). */
  output: string;
  /** The longer side of a tile, in pixels. */
  tile?: number;
  columns?: number;
  /** The most tiles a sheet holds; a longer video gets a wider interval, not a second sheet. */
  maxTiles?: number;
  /** The shortest interval between tiles, in seconds. */
  minInterval?: number;
  /** AVIF quality, 1–100. */
  quality?: number;
};

/** How to read a storyboard sheet: tile `i` is the frame at `i × interval`, row by row. */
type StoryboardSheet = {
  path: string;
  bytes: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  /** The tiles the sheet holds, which can be fewer than `columns × rows`. */
  count: number;
  /** Seconds between tiles. */
  interval: number;
  duration: number;
  /** `ffmpeg/<version>/<chain>+magick/<version>`: `cuda` decoded every frame, `keyframes` only those. */
  producer: string;
};

/**
 * A video's frames at an even interval, tiled into one AVIF sheet, written by EMS into `output`:
 * what a player's timeline shows under the pointer. The video must be upright (a
 * rendition); its sample aspect ratio is applied, so the tiles are its display shape.
 */
export const videoStoryboard = async (cmd: Command, path: string, opts: StoryboardOptions): Promise<StoryboardSheet> => {
  const body: Record<string, unknown> = {
    file: { path: path },
    output: { path: opts.output, format: 'avif', ...(opts.quality !== undefined ? { quality: opts.quality } : {}) },
    ...(opts.tile !== undefined ? { tile: opts.tile } : {}),
    ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
    ...(opts.maxTiles !== undefined ? { max_tiles: opts.maxTiles } : {}),
    ...(opts.minInterval !== undefined ? { min_interval: opts.minInterval } : {}),
  };
  const answer = await request(cmd, 'video.storyboard', body);
  const raw = answer.result as {
    bytes: number;
    tile: { width: number; height: number };
    columns: number;
    rows: number;
    count: number;
    interval: number;
    duration: number;
  };
  return {
    path: opts.output,
    bytes: raw.bytes,
    tileWidth: raw.tile.width,
    tileHeight: raw.tile.height,
    columns: raw.columns,
    rows: raw.rows,
    count: raw.count,
    interval: raw.interval,
    duration: raw.duration,
    producer: producerOf(answer),
  };
};

/** A video's cuts, from EMS's `video.shots`. */
type Shots = {
  duration: number;
  frames: number;
  cuts: { t: number; score: number | null; kind: 'cut' | 'leader' }[];
  /** The rules the cuts were found with, to record beside them. */
  params: Record<string, number>;
  /** `transnetv2+ffmpeg/<version>/<chain>`. */
  producer: string;
};

/** A rule of `video.shots` to set instead of EMS's default: the score a cut must reach. */
type ShotsOptions = {
  threshold?: number;
  /** False for a video that has no leader, such as a camera's take: no blank stretch is a gap, and none ends in a cut. */
  leader?: boolean;
};

/**
 * Where an upright video — a rendition — cuts from one shot to the next: TransNetV2 over every frame,
 * and EMS's rules with their measured defaults, or the threshold and leader rule the caller gives.
 */
export const videoShots = async (cmd: Command, path: string, opts: ShotsOptions = {}): Promise<Shots> => {
  const body = {
    file: { path: path },
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.leader !== undefined ? { leader: opts.leader } : {}),
  };
  const answer = await request(cmd, 'video.shots', body);
  const raw = answer.result as Omit<Shots, 'producer'>;
  return { duration: raw.duration, frames: raw.frames, cuts: raw.cuts ?? [], params: raw.params ?? {}, producer: producerOf(answer) };
};

type AudioTranscodeOptions = {
  output: string;
  mimetype?: string;
  /** Ceilings: EMS never exceeds the source's own bitrate or sample rate. */
  bitrate?: string;
  sampleRate?: number;
};

type AudioTranscodeResult = {
  path: string;
  duration: number | null;
  bytes: number;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** True when the source was already AAC in an MP4-family container and was remuxed, not re-encoded. */
  remuxed: boolean;
  producer: string;
};

/** The web rendition of a recording: AAC in an M4A-branded MP4, never carrying more than the source did. */
export const transcodeAudio = async (cmd: Command, path: string, opts: AudioTranscodeOptions): Promise<AudioTranscodeResult> => {
  const body: Record<string, unknown> = {
    file: { path: path, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) },
    output: { path: opts.output, format: 'm4a' },
    audio: { ...(opts.bitrate ? { bitrate: opts.bitrate } : {}), ...(opts.sampleRate ? { sample_rate: opts.sampleRate } : {}) },
  };
  const answer = await request(cmd, 'audio.transcode', body);
  const raw = answer.result as { duration: number | null; bytes: number; bitrate: number | null; sample_rate: number | null; channels: number | null; remuxed: boolean };
  return {
    path: opts.output,
    duration: raw.duration,
    bytes: raw.bytes,
    bitrate: raw.bitrate,
    sampleRate: raw.sample_rate,
    channels: raw.channels,
    remuxed: raw.remuxed === true,
    producer: producerOf(answer),
  };
};

type ProbeOptions = { mimetype?: string; hash?: boolean; raw?: ('exiftool' | 'ffprobe')[] };

/** What `media.probe` answers: a normalized core, and the tools' own dumps under `raw`. */
export type ProbeResult = {
  mimetype: string | null;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  size: number;
  sha256?: string;
  container?: string;
  duration?: number;
  bitrate?: number;
  picture?: {
    width?: number;
    height?: number;
    codec?: string;
    rotation?: number;
    orientation?: number;
    mirrored?: boolean;
    sar?: number;
    fps?: number;
    interlaced?: boolean;
    matrix_rotation?: number;
  };
  sound?: { codec?: string; channels?: number; sample_rate?: number };
  captured_at: { value: string; source: string; zone?: string }[];
  gps?: { lat: number; lon: number; alt?: number; dop?: number };
  device?: { make?: string; model?: string; serial?: string };
  /** False when no decoder will ever get a frame out of these bytes; `reason` says why. */
  decodable: boolean;
  reason?: string;
  raw: { exiftool?: Record<string, unknown>; ffprobe?: { format?: Record<string, unknown>; streams?: Record<string, unknown>[] } };
  /** `exiftool/<version>+ffprobe/<version>` — which tools answered. */
  producer: string;
};

/**
 * What is this file? exiftool and ffprobe in one call, normalized, with the raw dumps attached
 * for the readers that still want a tool's own tag names (`raw.exiftool` is the numeric,
 * ungrouped JSON `exiftool -n -j` writes).
 */
export const probe = async (cmd: Command, path: string, opts: ProbeOptions = {}): Promise<ProbeResult> => {
  const body: Record<string, unknown> = { file: { path: path, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) } };
  if (opts.hash) body.hash = true;
  if (opts.raw) body.raw = opts.raw;
  const raw = await request(cmd, 'media.probe', body);
  return { ...(raw.result as Omit<ProbeResult, 'producer'>), producer: producerOf(raw) };
};

/**
 * Fingerprints for finding copies: an SSCD descriptor for a picture, in the display frame `angle`
 * and `mirror` name, or for each of a video's keyframes; chromaprint for sound.
 */
export const fingerprint = async (
  cmd: Command,
  path: string,
  opts: { angle?: number; mirror?: boolean; mimetype?: string } = {},
): Promise<FingerprintResult> => {
  const raw = await request(cmd, 'fingerprint.compute', {
    file: { path: path, angle: opts.angle ?? 0, mirror: opts.mirror ?? false, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) },
  });
  const result = raw.result as {
    fingerprints: (
      | { kind: 'sscd-image' | 'sscd-video'; dimension: number; vector: number[]; label: string }
      | { kind: 'chromaprint'; fingerprint: number[]; label: string }
    )[];
  };
  return {
    fingerprints: result.fingerprints.map((f): Fingerprint =>
      f.kind === 'chromaprint' ? { type: f.kind, fingerprint: f.fingerprint, label: f.label } : { type: f.kind, dimension: f.dimension, vector: f.vector, label: f.label }
    ),
    producer: producerOf(raw),
  };
};

/** A line of text in a picture: its words, its four corners as fractions of the picture, and how sure the reader is. */
type TextLine = { text: string; box: [number, number][]; score: number };

/**
 * The language the text of a picture is in (ISO 639-1): as EMS told it from the reading, with how
 * sure it is, or as the caller gave it (`given`, no confidence).
 */
type TextLanguage = { code: string; confidence: number | null; given: boolean };

/**
 * `ocr.read`'s answer: the lines in reading order, their text joined by newlines, the language they
 * are in (null when too little text to tell), and the engine that read them.
 */
export type ReadTextResult = { text: string; lines: TextLine[]; width: number; height: number; language: TextLanguage | null; producer: string };

const textLanguageOf = (value: unknown): TextLanguage | null => {
  const language = value as Partial<TextLanguage> | null | undefined;
  if (!language || typeof language.code !== 'string' || !language.code) return null;
  return { code: language.code, confidence: typeof language.confidence === 'number' ? language.confidence : null, given: language.given === true };
};

/**
 * The lines of text in a picture (EMS `ocr.read`, PP-OCRv6), read in the display frame `angle` and
 * `mirror` name. A picture without text answers empty text and no lines. `language` (ISO 639-1)
 * is the one a person set: EMS reads in it instead of telling it from the text.
 */
export const readText = async (
  cmd: Command,
  path: string,
  opts: { angle?: number; mirror?: boolean; mimetype?: string; language?: string } = {},
): Promise<ReadTextResult> => {
  const raw = await request(cmd, 'ocr.read', {
    file: { path: path, angle: opts.angle ?? 0, mirror: opts.mirror ?? false, ...(opts.mimetype ? { mimetype: opts.mimetype } : {}) },
    ...(opts.language ? { language: opts.language } : {}),
  });
  const result = raw.result as { text: string; lines: TextLine[]; width: number; height: number };
  return {
    text: result.text,
    lines: result.lines,
    width: result.width,
    height: result.height,
    language: textLanguageOf(raw.meta?.language),
    producer: producerOf(raw),
  };
};

/** The text of a document (PDF, DOCX, ODT, plain text), a scanned page OCR'd. */
export const extractText = async (cmd: Command, path: string, mimetype: string): Promise<ExtractedText> => {
  const body: Record<string, unknown> = { file: { path: path, mimetype } };
  const result = await call(cmd, 'document.extract', body) as { text: string; pages: number; method: string; word_count: number };
  return { text: result.text, pages: result.pages, method: result.method, wordCount: result.word_count };
};

const getOn = async (cmd: Command, instance: EmsInstance, path: string, waitSeconds = 5): Promise<unknown | null> => {
  try {
    const response = await fetchInterruptible(cmd, path, `${instance.url}/${API_MAJOR}/${path}`, { headers: headers(instance) }, waitSeconds * 1000, 0);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
};

const PRIMARY_CAPABILITIES = Symbol.for('ein.ems.primary-capabilities');

/** The primary's capabilities as it last gave them in this process, for a stand-in to match. */
const lastPrimaryCapabilities = (): EmsCapabilities | undefined => (globalThis as unknown as Record<symbol, EmsCapabilities | undefined>)[PRIMARY_CAPABILITIES];

/** An instance's capabilities, or null when it is not answering. */
export const capabilitiesOf = async (cmd: Command, instance: EmsInstance, waitSeconds?: number): Promise<EmsCapabilities | null> => {
  const answer = await getOn(cmd, instance, 'capabilities', waitSeconds);
  if (!answer || typeof answer !== 'object') return null;
  if (instance.primary) (globalThis as unknown as Record<symbol, EmsCapabilities>)[PRIMARY_CAPABILITIES] = answer as EmsCapabilities;
  return answer as EmsCapabilities;
};

/**
 * What EMS stamps the results it makes with now. A stored result stamped otherwise was made by
 * something EMS no longer runs, in another space or with other settings, and is made again. A
 * field is null when EMS runs no such thing, or, for `transcribe`, while its model worker is down.
 */
type Generations = {
  /** The `signature` a transcript decoded now would carry (`transcribedWith`). */
  transcribe: string | null;
  /**
   * The signature of the CPU-decode budget EMS refuses transcodes against. Recorded beside a
   * refusal so a raised budget re-opens the gap on its own: a refusal counts only while the
   * signature it carries is the one in force.
   */
  cpuBudget: string | null;
  /** The image embedder `vision.embed` runs (`embeddedBy` of a picture vector). */
  imageEmbed: string | null;
  /** The face models `faces.detect` runs (`facesBy`). */
  faces: string | null;
  /** The engine `ocr.read` reads pictures with (`ocrBy`). */
  ocr: string | null;
  /** The text embedder `text.embed` runs (`embeddedBy` of a text vector). */
  textEmbed: string | null;
};

/**
 * Everything EMS stamps its results with now, from one `capabilities` request to the primary,
 * whichever instance the command calls, or null when the primary is not answering. Null is not
 * "none of them": a caller comparing stored results with these cannot tell which are stale, where a
 * null field says EMS runs no such thing. A batch caller passes a longer wait: capabilities asks the
 * model worker, which answers slowly while it loads its models.
 */
export const generations = async (cmd: Command, waitSeconds?: number): Promise<Generations | null> => {
  const capabilities = await capabilitiesOf(cmd, await primaryInstance(cmd), waitSeconds);
  if (!capabilities) return null;

  const named = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
  const ops = Array.isArray(capabilities.ops) ? capabilities.ops : [];
  const ran = (op: string, value: unknown): string | null => ops.includes(op) ? named(value) : null;
  const models = capabilities.models ?? {};

  return {
    transcribe: named(capabilities.signatures?.transcribe),
    cpuBudget: named(capabilities.encode?.cpu_budget),
    imageEmbed: ran('vision.embed', models.image_embed),
    faces: ran('faces.detect', models.faces),
    ocr: ran('ocr.read', models.ocr),
    textEmbed: named(models.text_embed),
  };
};

/** The health of `instance`, by default the one the command calls, or null when it is not answering. */
export const health = async (cmd: Command, instance?: EmsInstance): Promise<HealthResult | null> => {
  const target = instance ?? await readInstance(cmd, instanceName(cmd));
  if (!target) return null;
  const result = await getOn(cmd, target, 'health');
  return result && typeof result === 'object' && (result as HealthResult).ok ? result as HealthResult : null;
};

/**
 * What a watch reads and how (EMS 4.24): the stream, its faces and motion, whether a face's crop
 * comes, and the clips it cuts of the stream: what opens one, the seconds before and after it, the
 * longest, and the stream recorded when not the one watched.
 */
export type WatchSpec = {
  source: string;
  faces?: { fps?: number; min_size?: number; min_confidence?: number };
  motion?: boolean;
  mask?: Box[];
  angle?: 0 | 90 | 180 | 270;
  mirror?: boolean;
  crops?: boolean;
  clips?: { on?: ('face' | 'motion')[]; pre?: number; post?: number; max?: number; source?: string };
};

/** A watch as EMS reports it; `source` without its password. */
type WatchStatus = {
  id: string;
  source: string;
  state: 'connecting' | 'running' | 'lost';
  since: string;
  frames: number;
  looked: number;
  faces: number;
  following: number;
  motion: boolean;
  /** A watch with clips: its recording, and its clips. */
  clips?: { state: 'connecting' | 'recording' | 'lost'; segments: number; made: number; ready: number; open?: string; error?: string };
  error?: string;
  /** On a put: whether it was made now, rather than left running as it was. */
  made?: boolean;
};

/** A face a watch saw, in its `face` and `face.end` events. */
type WatchFace = {
  track: number;
  box: Box;
  confidence: number;
  frame: { width: number; height: number };
  embedding: number[];
  landmarks?: [number, number][];
  pose?: { pitch: number; yaw: number; roll: number };
  /** A JPEG of the face, base64. */
  crop?: { type: string; data: string };
  /** `face.end`'s: when it was seen, in `t`'s seconds, and how often. */
  appearances?: [number, number][];
  detections?: number;
};

/** One event of a watch (EMS 4.24): every one has `type`, `watch`, `at` and `t`. */
export type WatchEvent =
  & { watch: string; at: string; t: number }
  & (
    | ({ type: 'face' | 'face.end' } & WatchFace)
    | { type: 'motion' | 'motion.end' | 'source.back' }
    | { type: 'source.lost'; reason: string }
    | ({ type: 'clip' } & WatchClip)
    | { type: 'clip.failed'; clip: string; reason: string }
  );

/** A clip a watch cut, an MP4 EMS keeps until it is dropped: its id, when it starts and ends, its length in seconds, its bytes, and what opened it. */
type WatchClip = { clip: string; start: string; end: string; duration: number; size: number; reasons: ('face' | 'motion' | 'request')[] };

/** A watch's route on the instance the command calls, answered as an op's envelope is. */
const watchRequest = async (cmd: Command, method: string, path: string, body?: unknown): Promise<unknown> => {
  const instance = await emsInstance(cmd);
  const ems = who(instance);
  let response: Response;
  try {
    response = await fetchOnce(cmd, `watches ${method}`, `${instance.url}/${API_MAJOR}/${path}`, {
      method,
      headers: headers(instance),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, WATCH_REQUEST_MS);
  } catch (error) {
    if (error instanceof ConnectError) throw new EmsUnavailableError(`${ems}: watches unreachable: ${error.message}`);
    throw error;
  }
  const envelope = await response.json().catch(() => undefined) as Envelope | undefined;
  if (!envelope) throw new EmsUnavailableError(`${ems}: watches answered ${response.status} with no usable body`);
  if (!envelope.ok) {
    const code = envelope.error?.code ?? `http_${response.status}`;
    const message = envelope.error?.message ?? `HTTP ${response.status}`;
    if (code === 'busy' || code === 'model_unavailable') throw new EmsUnavailableError(`${ems}: watches ${message} (${code})`);
    throw new EmsError('watches', code, message, envelope.error?.permanent === true, response.status);
  }
  return envelope.result;
};

/** How long a watch's own request may take: it makes, lists or stops one, and waits on nothing. */
const WATCH_REQUEST_MS = 15_000;

/** Make the watch `id`, or leave it running when EMS has it with this spec already. */
export const putWatch = async (cmd: Command, id: string, spec: WatchSpec): Promise<WatchStatus> =>
  await watchRequest(cmd, 'PUT', `watches/${encodeURIComponent(id)}`, spec) as WatchStatus;

/** Every watch the instance runs, whoever stated it. */
export const listWatches = async (cmd: Command): Promise<WatchStatus[]> => await watchRequest(cmd, 'GET', 'watches') as WatchStatus[];

/** Stop the watch `id`. */
export const deleteWatch = async (cmd: Command, id: string): Promise<void> => {
  await watchRequest(cmd, 'DELETE', `watches/${encodeURIComponent(id)}`);
};

/** Open a clip of the watch `id` now, or lengthen the open one, `post` seconds on; answers its id. */
export const requestClip = async (cmd: Command, id: string, post?: number): Promise<string> =>
  (await watchRequest(cmd, 'POST', `watches/${encodeURIComponent(id)}/clips`, post === undefined ? {} : { post }) as { clip: string }).clip;

/** The clip `clip` of the watch `id`: its MP4's bytes as they come. */
export const clipBody = async (cmd: Command, id: string, clip: string): Promise<ReadableStream<Uint8Array>> => {
  const instance = await emsInstance(cmd);
  let response: Response;
  try {
    response = await fetch(`${instance.url}/${API_MAJOR}/watches/${encodeURIComponent(id)}/clips/${encodeURIComponent(clip)}`, { headers: headers(instance) });
  } catch (error) {
    throw new EmsUnavailableError(`${who(instance)}: clip ${clip} unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) {
    const envelope = await response.json().catch(() => undefined) as Envelope | undefined;
    throw new EmsError(
      'watches',
      envelope?.error?.code ?? `http_${response.status}`,
      envelope?.error?.message ?? `HTTP ${response.status}`,
      envelope?.error?.permanent === true,
      response.status,
    );
  }
  return response.body;
};

/** Drop the clip `clip` of the watch `id` from EMS. */
export const dropClip = async (cmd: Command, id: string, clip: string): Promise<void> => {
  await watchRequest(cmd, 'DELETE', `watches/${encodeURIComponent(id)}/clips/${encodeURIComponent(clip)}`);
};

/**
 * What the watch `id` sees, as it comes, until `signal` aborts, the watch is deleted or EMS goes
 * away, when it ends. The stream's opening `state` event is left out.
 */
export async function* watchEvents(cmd: Command, id: string, signal: AbortSignal): AsyncGenerator<WatchEvent> {
  const instance = await emsInstance(cmd);
  let response: Response;
  try {
    response = await fetch(`${instance.url}/${API_MAJOR}/watches/${encodeURIComponent(id)}/events`, {
      headers: { ...headers(instance), accept: 'text/event-stream' },
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw new EmsUnavailableError(`${who(instance)}: watch ${id} unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) {
    const envelope = await response.json().catch(() => undefined) as Envelope | undefined;
    throw new EmsError('watches', envelope?.error?.code ?? `http_${response.status}`, envelope?.error?.message ?? `HTTP ${response.status}`, false, response.status);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        let event = '';
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!event || event === 'state' || data.length === 0) continue;
        if (event === 'end') return;
        yield JSON.parse(data.join('\n')) as WatchEvent;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
