/**
 * A page of this EiN as live video for a screen: the media service opens the page in a browser of
 * its own, signed in once with a page ticket as whoever asked, read-only, and encodes what it shows
 * as H.264 (EMS's `pages`) into two stream nodes made for it, `/tmp/page-streams/<id>.mp4`
 * (fragmented MP4, a Cast player's) and `.ts` (MPEG-TS, a DLNA screen's), whoever asked's alone,
 * which `ems-files` grants it for writing for as long as the page runs. A reader joins either at
 * its latest keyframe; a screen on the network reads one with a file ticket. EiN serves at an
 * unguessable `/live/<id>/` the forms a browser hands a screen near it, made from the nodes:
 * `screen.mp4`, the MP4 with its clock at 0, a header that says it lasts a day and a second of it at
 * once, which Chrome hands a Cast screen (it hands none an endless MP4, which it counts as long as
 * it has read, nor HLS on Android), and the live HLS `index.m3u8`, which Safari hands an AirPlay
 * screen. The stream carries the page's sound; keys pressed for it reach the page
 * (`pressPageStream`), which says what it shows (`pageStreamState`) and takes messages
 * (`tellPageStream`). It stops when it is stopped, and on its own once neither node has had a
 * reader for its idle seconds.
 * When it stops, the session the media service's browser signed in with ends with it
 * (`endPageSignIn`).
 *
 * The media service reaches the page at `CFG_EMS_PAGE_ADDRESS`, or where it reaches EiN's files
 * (`CFG_EMS_FILES_ADDRESS`) at EiN's own HTTP port, as the system's files hold them, and the page
 * goes only to the media service the system's `CFG_EMS_URL` names: a caller's environment never
 * says where the media service's browser goes, nor who is handed the page's address, which signs
 * whoever opens it in. The streams are kept in this process's memory.
 */

import { type Access, ADMIN_ACCESS, type Command, type ModuleDevices, readSystemSettings, type ServedFile } from '@ein/client';
import { deletePage, EmsBusyError, emsInstance, EmsUnavailableError, listPages, pageMessage, pageState, pressPageKeys, putPage } from './client.ts';
import { endRunning, forRunning } from './files.ts';
import type { EmsInstance } from './instances.ts';
import { LiveHls } from './live/hls.ts';
import { screenMp4 } from './live/screen.ts';

type PageStreamOptions = {
  width?: number;
  height?: number;
  fps?: number;
  /** Seconds without a reader after which it stops, `DEFAULT_IDLE_SECONDS` when absent. */
  idle?: number;
  /** Whose the page is: whoever asked, by default the command's caller. */
  access?: Access;
};

/**
 * A page streamed: its stream nodes (`<path>.mp4`, `<path>.ts`, read as its owner reads them), the
 * MP4 for a screen near a browser (`remote`) and the playlist (`hls`), what it shows, and for whom.
 */
export type PageStream = {
  id: string;
  path: string;
  remote: string;
  hls: string;
  route: string;
  uid: number;
  startedAt: number;
};

type Vfs = Command['sys']['vfs'];

type Held = PageStream & {
  instance: EmsInstance;
  vfs: Vfs;
  access: Access;
  idle: number;
  /** When either node last had a reader, or the stream started. */
  lastRead: number;
  /** The stream no longer served. */
  end(): void;
  /** The sessions the media service's browser signed in with ended, which closes its sockets. */
  endSignIns(): Promise<void>;
};

/** Where the stream nodes are. */
const DIR = '/tmp/page-streams';

/** How long a page goes unread before it stops, when the caller says nothing. */
const DEFAULT_IDLE_SECONDS = 20;

/** How often a stream's readers are counted. */
const IDLE_CHECK_MS = 2_000;

const KEY = Symbol.for('ein.ems.page-streams');

/** The streams this process serves, by id: one map whichever copy of this file a command loaded. */
const held = (): Map<string, Held> => ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<string, Held>()) as Map<string, Held>;

const visible = ({ id, path, remote, hls, route, uid, startedAt }: Held): PageStream => ({ id, path, remote, hls, route, uid, startedAt });

/** How long the MP4 for a screen near a browser says it lasts: a day, in seconds. */
const REMOTE_SECONDS = 86_400;

/** Calls to the media service made after the command that started the stream is gone: never interrupted. */
const LASTING = { interrupted: false };

/** `http://host:port` where the media service reaches this EiN's pages, from the system's `settings`. */
export const pageOrigin = (settings: Readonly<Record<string, string>>): string => {
  const own = (settings.CFG_EMS_PAGE_ADDRESS ?? '').trim();
  if (own) return `http://${own}`;
  const files = (settings.CFG_EMS_FILES_ADDRESS ?? '').trim();
  const host = files.replace(/:\d+$/, '');
  if (!host) throw new EmsUnavailableError('ems: pages: CFG_EMS_PAGE_ADDRESS and CFG_EMS_FILES_ADDRESS are both empty, so EMS reaches no page of this EiN');
  return `http://${host}:${(settings.CFG_HTTP_PORT ?? '').trim() || '8080'}`;
};

/** The settings that say which media service is handed a page's address. */
const PAGE_SETTINGS = ['CFG_EMS_URL', 'CFG_EMS_FILES_ADDRESS'] as const;

/**
 * `cmd`'s environment with the page settings the system's files hold: any shell can set one in front
 * of a command, and the page's address would then go wherever it points.
 */
const pageEnv = async (cmd: Command): Promise<Record<string, string>> => {
  const system = await readSystemSettings(cmd.sys.vfs);
  const env = { ...cmd.env };
  for (const key of PAGE_SETTINGS) {
    if (system[key] === undefined) delete env[key];
    else env[key] = system[key];
  }
  return env;
};

/** The media service that renders pages: the one the system's settings name. */
export const pagesInstance = async (cmd: Command): Promise<EmsInstance> => await emsInstance({ sys: cmd.sys, env: await pageEnv(cmd) });

const devicesOf = (cmd: Command): ModuleDevices => {
  if (!cmd.sys.devices) throw new Error('devices are not running here, and a page is streamed to them');
  return cmd.sys.devices;
};

/** The stream nodes of the page `id`, `access`'s alone: `<stem>.mp4` and `<stem>.ts`. */
const makeNodes = async (vfs: Vfs, access: Access, id: string, route: string): Promise<string> => {
  await vfs.ensure(ADMIN_ACCESS, 'directory', '/tmp', DIR.slice('/tmp/'.length), { props: { mode: 0o755 } });
  const props = { uid: access.uid, gid: access.gid, mode: 0o600 };
  await vfs.create(ADMIN_ACCESS, 'stream', DIR, `${id}.mp4`, { props, attrs: { mimetype: 'video/mp4', label: route } });
  await vfs.create(ADMIN_ACCESS, 'stream', DIR, `${id}.ts`, { props, attrs: { mimetype: 'video/mp2t', label: route } });
  return `${DIR}/${id}`;
};

/** The stream nodes at `stem` removed, which ends their readers; those already gone are left. */
const removeNodes = async (vfs: Vfs, stem: string): Promise<void> => {
  for (const extension of ['mp4', 'ts']) await vfs.unlink(ADMIN_ACCESS, `${stem}.${extension}`, DIR).catch(() => {});
};

/** How many read the stream's nodes now. */
const readersOf = async (stream: Pick<Held, 'vfs' | 'path'>): Promise<number> => {
  let readers = 0;
  for (const extension of ['mp4', 'ts']) {
    const stat = await stream.vfs.stat(ADMIN_ACCESS, `${stream.path}.${extension}`).catch(() => undefined) as { readers?: number } | undefined;
    readers += stat?.readers ?? 0;
  }
  return readers;
};

/**
 * Stream the page at `route` (`/dashboard-wall/Kitchen`) as it shows to `opts.access`, the caller
 * by default. Answers once the media service has its first picture; the page itself may still be
 * loading then. When the media service streams as many pages as it may, the streams of the same
 * person that nobody reads make room: a new one replaces one left behind.
 */
export const startPageStream = async (cmd: Command, route: string, opts: PageStreamOptions = {}): Promise<PageStream> => {
  const devices = devicesOf(cmd);
  const access = opts.access ?? cmd.access;
  const origin = pageOrigin(await readSystemSettings(cmd.sys.vfs));
  const instance = await pagesInstance(cmd);
  const id = `page-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const video = {
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.height !== undefined ? { height: opts.height } : {}),
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
  };
  const vfs = cmd.sys.vfs;
  const stem = await makeNodes(vfs, access, id, route);
  const slot = `pages/${id}`;
  // The page's sign-ins, whose sessions end with the stream: one, or two when the first put made room.
  const signIns: string[] = [];
  const endSignIns = async () => {
    for (const path of signIns) await devices.endPageSignIn(path);
  };
  const put = async () => {
    const signIn = devices.pageSignIn(access, route);
    signIns.push(signIn);
    const spec = {
      url: `${origin}${signIn}`,
      ...(Object.keys(video).length ? { video } : {}),
      output: { mp4: { path: `${stem}.mp4` }, ts: { path: `${stem}.ts` } },
    };
    // The nodes are granted as whoever asked, whose they are.
    const granted = await forRunning({ sys: cmd.sys, access }, instance.url, slot, spec);
    if (!granted) throw new EmsUnavailableError(`ems: pages: ems-files serves no files (CFG_EMS_FILES_ADDRESS, the ems-files service)`);
    try {
      await putPage(cmd, instance, id, granted.body, granted.headers);
    } finally {
      await granted.settled();
    }
  };
  try {
    try {
      await put();
    } catch (error) {
      if (!(error instanceof EmsBusyError)) throw error;
      const unread = await unreadOf(cmd, instance, access.uid);
      if (!unread.length) throw new EmsBusyError(`the media service streams as many pages as it may (EMS_PAGES), and someone watches each: ${error.message}`);
      for (const each of unread) await stopPageStream(cmd, each);
      await put();
    }
  } catch (error) {
    await endRunning(instance.url, slot);
    await removeNodes(vfs, stem);
    await endSignIns();
    throw error;
  }
  const hls = new LiveHls(() => vfs.open(access, `${stem}.ts`, { mode: 'r' }));
  const files = devices.serveFiles(async (name): Promise<ServedFile | undefined> => {
    if (name !== 'screen.mp4') return await hls.get(name);
    const handle = await vfs.open(access, `${stem}.mp4`, { mode: 'r' });
    return { body: screenMp4(handle, REMOTE_SECONDS), type: 'video/mp4' };
  });
  const stream: Held = {
    id,
    path: stem,
    remote: `${files.path}/screen.mp4`,
    hls: `${files.path}/index.m3u8`,
    route,
    uid: access.uid,
    startedAt: Date.now(),
    instance,
    vfs,
    access,
    idle: opts.idle ?? DEFAULT_IDLE_SECONDS,
    lastRead: Date.now(),
    end: () => {
      clearInterval(check);
      files.end();
      hls.stop();
    },
    endSignIns,
  };
  const check = setInterval(() => void idleCheck(stream), IDLE_CHECK_MS);
  held().set(id, stream);
  return visible(stream);
};

/** Stop the stream once its nodes have had no reader for its idle seconds. */
const idleCheck = async (stream: Held): Promise<void> => {
  if ((await readersOf(stream)) > 0) stream.lastRead = Date.now();
  else if (Date.now() - stream.lastRead > stream.idle * 1000) await endStream(stream);
};

/** The stream no longer served, the media service's browser closed and signed out, its names ended and its nodes removed. */
const endStream = async (stream: Held): Promise<void> => {
  if (held().get(stream.id) !== stream) return;
  held().delete(stream.id);
  stream.end();
  try {
    await deletePage(LASTING, stream.instance, stream.id);
  } finally {
    await stream.endSignIns();
    await endRunning(stream.instance.url, `pages/${stream.id}`);
    await removeNodes(stream.vfs, stream.path);
  }
};

/** The ids of the streams of `uid` on `instance` that nobody reads now. */
const unreadOf = async (cmd: Command, instance: EmsInstance, uid: number): Promise<string[]> => {
  const rendering = await listPages(cmd, instance);
  const unread: string[] = [];
  for (const stream of held().values()) {
    if (stream.uid !== uid || stream.instance.url !== instance.url) continue;
    const page = rendering.find((each) => each.id === stream.id);
    if (!page || page.state === 'ended' || (await readersOf(stream)) === 0) unread.push(stream.id);
  }
  return unread;
};

/** The page streams this EiN serves. */
export const pageStreams = (): PageStream[] => [...held().values()].map(visible);

/** How many read the stream nodes of the stream `id` now; 0 when there is none. */
export const pageStreamReaders = async (id: string): Promise<number> => {
  const stream = held().get(id);
  return stream ? await readersOf(stream) : 0;
};

/** Stop the page stream `id`: no longer served, and the media service's browser closed. False when there is none. */
export const stopPageStream = async (_cmd: Command, id: string): Promise<boolean> => {
  const stream = held().get(id);
  if (!stream) return false;
  await endStream(stream);
  return true;
};

/** Press `keys` in the page of the stream `id`, as someone at it would. False when there is none. */
export const pressPageStream = async (cmd: Command, id: string, keys: string[]): Promise<boolean> => {
  const stream = held().get(id);
  if (!stream) return false;
  await pressPageKeys(cmd, stream.instance, id, keys);
  return true;
};

/** What the page of the stream `id` says it shows, or null; undefined when there is no such stream. */
export const pageStreamState = async (cmd: Command, id: string): Promise<unknown> => {
  const stream = held().get(id);
  return stream ? await pageState(cmd, stream.instance, id) : undefined;
};

/** Hand the page of the stream `id` a message: whether it took it; undefined when there is no such stream. */
export const tellPageStream = async (cmd: Command, id: string, message: Record<string, unknown>): Promise<boolean | undefined> => {
  const stream = held().get(id);
  return stream ? await pageMessage(cmd, stream.instance, id, message) : undefined;
};

/** End the streams the media service no longer renders, of those `rendering` (its page ids) leaves out. */
export const forgetEnded = async (rendering: Set<string>): Promise<void> => {
  for (const stream of [...held().values()]) {
    if (!rendering.has(stream.id)) await endStream(stream).catch(() => {});
  }
};
