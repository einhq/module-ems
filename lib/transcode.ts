/**
 * A live stream transcoded into another by the media service (EMS's `transcodes`): a stream node
 * the caller reads (a camera's `main.ts`, whose codec a browser or a screen cannot play) read by EMS
 * and written, as H.264 and AAC, into a stream node the caller names or one made for it, both
 * granted through `ems-files` for as long as it runs. The output's media type says what EMS writes:
 * fragmented MP4 into a `video/mp4` node, else MPEG-TS. One made for it is
 * `/tmp/stream-transcodes/<id>.mp4`, the caller's alone, and removed when the transcode ends. It
 * stops when it is stopped, and on its own once its output has had no reader for its idle seconds,
 * counted from its start.
 *
 * The transcodes are kept in this process's memory.
 */

import { type Access, ADMIN_ACCESS, type Command } from '@ein/client';
import { basename, dirname } from '@std/path/posix';
import type { TranscodeStream } from './api.ts';
import { deleteTranscode, emsInstance, EmsUnavailableError, putTranscode } from './client.ts';
import { endRunning, forRunning } from './files.ts';
import type { EmsInstance } from './instances.ts';

type TranscodeOptions = {
  /** The picture at most this many pixels high. */
  height?: number;
  /** Seconds without a reader of the output after which it stops, `DEFAULT_IDLE_SECONDS` when absent. */
  idle?: number;
};

type Vfs = Command['sys']['vfs'];

/** A transcode this process runs; `made` when its output was made for it, and goes with it. */
type Held = TranscodeStream & { instance: EmsInstance; vfs: Vfs; idle: number; lastRead: number; check: ReturnType<typeof setInterval>; made: boolean };

/** How long a transcode's output goes unread before it stops, when the caller says nothing. */
const DEFAULT_IDLE_SECONDS = 60;

/** How often the output's readers are counted. */
const IDLE_CHECK_MS = 2_000;

/** Where the outputs made for a transcode are. */
const MADE_DIR = '/tmp/stream-transcodes';

const KEY = Symbol.for('ein.ems.transcodes');

/** Calls to the media service made after the command that started the transcode is gone: never interrupted. */
const LASTING = { interrupted: false };

/** The transcodes this process runs, by id: one map whichever copy of this file a command loaded. */
const held = (): Map<string, Held> => ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<string, Held>()) as Map<string, Held>;

const visible = ({ id, source, output, uid, startedAt }: Held): TranscodeStream => ({ id, source, output, uid, startedAt });

/** What a stream node of `path`'s name carries when it is made here: fragmented MP4 for `.mp4`, else MPEG-TS. */
const mimetypeOf = (path: string): string => path.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t';

/**
 * The stream node at `path`, made as `access`'s when it is not there; throws when something else is.
 * Answers what EMS is to write into it.
 */
const outputNode = async (vfs: Vfs, access: Access, path: string): Promise<'mp4' | 'mpegts'> => {
  const node = await vfs.get(access, path).catch(() => undefined);
  if (node && node.type !== 'stream') throw new Error(`${path} is a ${node.type}, not a stream`);
  if (!node) await vfs.create(access, 'stream', dirname(path), basename(path), { attrs: { mimetype: mimetypeOf(path), codec: 'h264' } });
  return (node?.attrs.mimetype ?? mimetypeOf(path)) === 'video/mp4' ? 'mp4' : 'mpegts';
};

/** A stream node for the transcode `id` to write fragmented MP4 into, `access`'s alone. */
const madeNode = async (vfs: Vfs, access: Access, id: string): Promise<string> => {
  await vfs.ensure(ADMIN_ACCESS, 'directory', '/tmp', MADE_DIR.slice('/tmp/'.length), { props: { mode: 0o755 } });
  const props = { uid: access.uid, gid: access.gid, mode: 0o600 };
  await vfs.create(ADMIN_ACCESS, 'stream', MADE_DIR, `${id}.mp4`, { props, attrs: { mimetype: 'video/mp4', codec: 'h264' } });
  return `${MADE_DIR}/${id}.mp4`;
};

/** How many read the output now. */
const readersOf = async (transcode: Pick<Held, 'vfs' | 'output'>): Promise<number> => {
  const stat = await transcode.vfs.stat(ADMIN_ACCESS, transcode.output).catch(() => undefined) as { readers?: number } | undefined;
  return stat?.readers ?? 0;
};

/**
 * Transcode the stream node `source` into `output`, a stream node made when it is not there, as the
 * caller reads and writes them; without `output`, into one made for it. Answers once the media
 * service has the output open.
 */
export const startTranscode = async (cmd: Command, source: string, output: string | undefined, opts: TranscodeOptions = {}): Promise<TranscodeStream> => {
  const vfs = cmd.sys.vfs;
  const node = await vfs.get(cmd.access, source);
  if (node.type !== 'stream') throw new Error(`${source} is a ${node.type}, not a stream`);
  const id = `transcode-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const format = output === undefined ? 'mp4' : await outputNode(vfs, cmd.access, output);
  const instance = await emsInstance(cmd);
  const written = output ?? await madeNode(vfs, cmd.access, id);
  const unmake = () => output === undefined ? vfs.unlink(ADMIN_ACCESS, written, MADE_DIR).catch(() => false) : Promise.resolve(false);
  const slot = `transcodes/${id}`;
  const spec = { source: { path: source }, output: { path: written }, format, ...(opts.height !== undefined ? { video: { height: opts.height } } : {}) };
  const granted = await forRunning(cmd, instance.url, slot, spec).catch(async (error) => {
    await unmake();
    throw error;
  });
  if (!granted) {
    await unmake();
    throw new EmsUnavailableError(`ems: transcodes: ems-files serves no files (CFG_EMS_FILES_ADDRESS, the ems-files service)`);
  }
  try {
    await putTranscode(cmd, instance, id, granted.body, granted.headers);
  } catch (error) {
    await endRunning(instance.url, slot);
    await unmake();
    throw error;
  } finally {
    await granted.settled();
  }
  const transcode: Held = {
    id,
    source,
    output: written,
    uid: cmd.access.uid,
    startedAt: Date.now(),
    instance,
    vfs,
    idle: opts.idle ?? DEFAULT_IDLE_SECONDS,
    lastRead: Date.now(),
    check: setInterval(() => void idleCheck(transcode), IDLE_CHECK_MS),
    made: output === undefined,
  };
  held().set(id, transcode);
  return visible(transcode);
};

const idleCheck = async (transcode: Held): Promise<void> => {
  if ((await readersOf(transcode)) > 0) transcode.lastRead = Date.now();
  else if (Date.now() - transcode.lastRead > transcode.idle * 1000) await endTranscode(transcode);
};

/** The transcode stopped in the media service, and its names ended. */
const endTranscode = async (transcode: Held): Promise<void> => {
  if (held().get(transcode.id) !== transcode) return;
  held().delete(transcode.id);
  clearInterval(transcode.check);
  try {
    await deleteTranscode(LASTING, transcode.instance, transcode.id);
  } finally {
    await endRunning(transcode.instance.url, `transcodes/${transcode.id}`);
    if (transcode.made) await transcode.vfs.unlink(ADMIN_ACCESS, transcode.output, MADE_DIR).catch(() => false);
  }
};

/** The transcodes this EiN runs. */
export const transcodes = (): TranscodeStream[] => [...held().values()].map(visible);

/** How many read the output of the transcode `id` now; 0 when there is none. */
export const transcodeReaders = async (id: string): Promise<number> => {
  const transcode = held().get(id);
  return transcode ? await readersOf(transcode) : 0;
};

/** Stop the transcode `id`. False when there is none. */
export const stopTranscode = async (id: string): Promise<boolean> => {
  const transcode = held().get(id);
  if (!transcode) return false;
  await endTranscode(transcode);
  return true;
};

/** End the transcodes the media service no longer runs, of those `running` (its transcode ids) leaves out. */
export const forgetEndedTranscodes = async (running: Set<string>): Promise<void> => {
  for (const transcode of [...held().values()]) {
    if (!running.has(transcode.id)) await endTranscode(transcode).catch(() => {});
  }
};
