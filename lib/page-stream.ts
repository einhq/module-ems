/**
 * A page of this EiN as live video for a screen: the media service opens the page in a browser of
 * its own, signed in once with a page ticket as whoever asked, read-only, and encodes what it shows
 * as H.264 (EMS's `pages`); EiN serves the stream at an unguessable `/live/<id>.mp4` and `.ts`, which
 * a Cast player or a DLNA screen fetches with no session, and at another, `/live/<id>/`, the forms
 * a browser hands a screen near it: `screen.mp4`, the MP4 whose header says it lasts a day, which
 * Chrome hands a Cast screen (it hands none an endless MP4, which it counts as long as it has read,
 * nor HLS on Android), and the live HLS `index.m3u8`, which Safari hands an AirPlay screen. The
 * stream stops when it is stopped, and on its own once nobody has read it for its idle seconds.
 *
 * The media service reaches the page at `CFG_EMS_PAGE_ADDRESS`, or where it reaches EiN's files
 * (`CFG_EMS_FILES_ADDRESS`) at EiN's own HTTP port. The streams are kept in this process's memory.
 */

import type { Access, Command, ModuleDevices } from '@ein/client';
import { deletePage, EmsBusyError, emsInstance, EmsUnavailableError, listPages, pageBody, pageFile, putPage } from './client.ts';
import type { EmsInstance } from './instances.ts';

type PageStreamOptions = {
  width?: number;
  height?: number;
  fps?: number;
  /** Seconds without a reader after which it stops; the media service's default (20) when absent. */
  idle?: number;
  /** Whose the page is: whoever asked, by default the command's caller. */
  access?: Access;
};

/** A page streamed: where to read it (`<path>.mp4`, `<path>.ts`, the MP4 for a screen near a browser `remote`, the playlist `hls`), what it shows, and for whom. */
export type PageStream = {
  id: string;
  path: string;
  remote: string;
  hls: string;
  route: string;
  uid: number;
  startedAt: number;
};

type Held = PageStream & { instance: EmsInstance; end(): void };

const KEY = Symbol.for('ein.ems.page-streams');

/** The streams this process serves, by id: one map whichever copy of this file a command loaded. */
const held = (): Map<string, Held> => ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<string, Held>()) as Map<string, Held>;

const visible = ({ id, path, remote, hls, route, uid, startedAt }: Held): PageStream => ({ id, path, remote, hls, route, uid, startedAt });

/** How long the MP4 for a screen near a browser says it lasts: a day, in seconds. */
const REMOTE_SECONDS = 86_400;

/** `http://host:port` where the media service reaches this EiN's pages. */
export const pageOrigin = (env: Record<string, string>): string => {
  const own = (env.CFG_EMS_PAGE_ADDRESS ?? '').trim();
  if (own) return `http://${own}`;
  const files = (env.CFG_EMS_FILES_ADDRESS ?? '').trim();
  const host = files.replace(/:\d+$/, '');
  if (!host) throw new EmsUnavailableError('ems: pages: CFG_EMS_PAGE_ADDRESS and CFG_EMS_FILES_ADDRESS are both empty, so EMS reaches no page of this EiN');
  return `http://${host}:${(env.CFG_HTTP_PORT ?? '').trim() || '8080'}`;
};

const devicesOf = (cmd: Command): ModuleDevices => {
  if (!cmd.sys.devices) throw new Error('devices are not running here, and a page is streamed to them');
  return cmd.sys.devices;
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
  const origin = pageOrigin(cmd.env);
  const instance = await emsInstance(cmd);
  const id = `page-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const video = {
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.height !== undefined ? { height: opts.height } : {}),
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
  };
  const put = () =>
    putPage(cmd, instance, id, {
      url: `${origin}${devices.pageSignIn(access, route)}`,
      ...(Object.keys(video).length ? { video } : {}),
      ...(opts.idle !== undefined ? { idle: opts.idle } : {}),
    });
  try {
    await put();
  } catch (error) {
    if (!(error instanceof EmsBusyError)) throw error;
    const unread = await unreadOf(cmd, instance, access.uid);
    if (!unread.length) throw new EmsBusyError(`the media service streams as many pages as it may (EMS_PAGES), and someone watches each: ${error.message}`);
    for (const each of unread) await stopPageStream(cmd, each);
    await put();
  }
  const streams = held();
  const served = devices.serveLive(async (format) => {
    const body = await pageBody(instance, id, format);
    if (!body) streams.delete(id);
    return body;
  });
  const files = devices.serveFiles(async (name) => {
    if (name !== 'screen.mp4') return await pageFile(instance, id, name);
    const body = await pageBody(instance, id, 'mp4', REMOTE_SECONDS);
    return body ? { body, type: 'video/mp4' } : undefined;
  });
  const end = () => {
    served.end();
    files.end();
  };
  const stream: Held = {
    id,
    path: served.path,
    remote: `${files.path}/screen.mp4`,
    hls: `${files.path}/index.m3u8`,
    route,
    uid: access.uid,
    startedAt: Date.now(),
    instance,
    end,
  };
  streams.set(id, stream);
  return visible(stream);
};

/** The ids of the streams of `uid` on `instance` that nobody reads now. */
const unreadOf = async (cmd: Command, instance: EmsInstance, uid: number): Promise<string[]> => {
  const rendering = await listPages(cmd, instance);
  return [...held().values()].filter((stream) => {
    if (stream.uid !== uid || stream.instance.url !== instance.url) return false;
    const page = rendering.find((each) => each.id === stream.id);
    return !page || page.state === 'ended' || page.readers.mp4 + page.readers.ts + page.readers.hls === 0;
  }).map((stream) => stream.id);
};

/** The page streams this EiN serves. */
export const pageStreams = (): PageStream[] => [...held().values()].map(visible);

/** Stop the page stream `id`: no longer served, and the media service's browser closed. False when there is none. */
export const stopPageStream = async (cmd: Command, id: string): Promise<boolean> => {
  const stream = held().get(id);
  if (!stream) return false;
  held().delete(id);
  stream.end();
  await deletePage(cmd, stream.instance, id);
  return true;
};

/** Forget the streams the media service no longer renders, of those `rendering` (its page ids) leaves out. */
export const forgetEnded = (rendering: Set<string>): void => {
  for (const [id, stream] of held()) {
    if (rendering.has(id)) continue;
    stream.end();
    held().delete(id);
  }
};
