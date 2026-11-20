/**
 * EiN's files for the media service: the names a request's files have for it, and where it
 * reaches them.
 *
 * EMS has no files of its own; the `ems-files` service serves it a request's over SFTP. Each request
 * gets a directory of its own, `/<grant>/`, and each file it names a name there, `<n>-<its VFS
 * name>`: the request's body says those names, and the endpoint knows what each stands for — a file
 * on this host's disk, a node read or written through the VFS, or a stream node whose bytes are
 * read from the moment the name is opened, or written by its one writer — for as long as the
 * request runs (a watch's or a page's for as long as it runs). Nothing else is there, and nothing
 * is listed. The VFS name keeps the original's extension, which
 * tools pick a format by.
 *
 * The state hangs off `globalThis` rather than this file: a module's files are loaded once per
 * process per content, so a daemon started before a module update and a bin loaded after it run
 * different copies of this file, and must still share one set of names. A thread of its own has
 * a state of its own: each of the endpoint's session threads keeps a copy of the names, which each
 * change reaches through `mirrors` before the change is done.
 */

import type { Command } from '@ein/client';
import { basename, normalize } from '@std/path/posix';

/** What a request's name stands for, and whether it is read or written. */
export type Named = {
  mode: 'read' | 'write';
  /** The file on this host's disk, when there is one. */
  disk?: string;
  /** The VFS path of a node with no file on disk (the db tier, a stream), read or written through the VFS. */
  node?: string;
  /**
   * Set for a stream node: read, its bytes from the moment the name is opened, without end; written,
   * its one writer, in order.
   */
  stream?: true;
};

/** An endpoint that serves a media service the files of its requests, as the client names it to EMS. */
export type FilesEndpoint = {
  /** `host:port`, as EMS reaches this endpoint. */
  address: string;
  /** The media service the names are for: the system's own (`CFG_EMS_URL` of the service). */
  emsUrl: string;
  /** The secret a plain connection answers the challenge with, in hex. */
  secret?: string;
  /** For TLS: the server's certificate, which EMS pins, and the client certificate and key EMS presents, all PEM. */
  tls?: { server: string; client: { cert: string; key: string } };
};

/** Names and directories added or ended together, as a copy of the names takes them in. */
export type NamesChange = { set?: [string, Named][]; grants?: string[]; ended?: string[]; ungrants?: string[] };

/** A copy of the names elsewhere; the promise settles once the copy has the change. */
export type NamesMirror = (change: NamesChange) => Promise<void>;

/** The names of something EMS runs (a watch, a page): its body with them, the header naming their endpoint, and what ends them. */
type RunningGrant = { key: string; body: unknown; headers: Record<string, string>; release: () => Promise<void> };

/**
 * `endpoints` by the media service they serve; `names` by their full path, `/<grant>/<n>-<name>`;
 * `grants` are the requests' directories; `mirrors` the copies kept of them; `running` the names of
 * what EMS runs for as long as it runs, by `<media service> <what>/<id>`.
 */
type FilesState = {
  endpoints: Map<string, FilesEndpoint>;
  names: Map<string, Named>;
  grants: Set<string>;
  mirrors: Set<NamesMirror>;
  running: Map<string, RunningGrant>;
};

const STATE = Symbol.for('ein.ems.files.names');

export const filesState = (): FilesState => {
  const global = globalThis as unknown as Record<symbol, Partial<FilesState> | undefined>;
  // A state an earlier copy of this file made lacks what was added since; the copy that needs it adds it.
  const state = global[STATE] ??= {};
  state.endpoints ??= new Map();
  state.names ??= new Map();
  state.grants ??= new Set();
  state.mirrors ??= new Set();
  state.running ??= new Map();
  return state as FilesState;
};

/** Apply a change to this thread's names, and to every copy of them; settles when all have it. */
export const changeNames = (change: NamesChange): Promise<void> => {
  const { names, grants, mirrors } = filesState();
  for (const [name, named] of change.set ?? []) names.set(name, named);
  for (const directory of change.grants ?? []) grants.add(directory);
  for (const name of change.ended ?? []) names.delete(name);
  for (const directory of change.ungrants ?? []) grants.delete(directory);
  return Promise.all([...mirrors].map((mirror) => mirror(change))).then(() => {});
};

/** An absolute path in its one spelling, or undefined for anything else. */
export const canonical = (path: string): string | undefined => (path.startsWith('/') ? normalize(path) : undefined);

/** What a path the endpoint is asked for is: a name, one of the directories, or nothing. */
export const lookup = (path: string): Named | 'directory' | undefined => {
  const { names, grants } = filesState();
  if (path === '/' || grants.has(path)) return 'directory';
  return names.get(path);
};

const hex = (bytes: number): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * `EMS-Files`'s value: `address=…; secret=…` for a plain endpoint, or `address=…; tls=…; client=…`
 * for TLS, the server's certificate and the client's certificate and key as PEM in base64.
 */
export const headerValue = (endpoint: FilesEndpoint): string =>
  endpoint.tls
    ? `address=${endpoint.address}; tls=${btoa(endpoint.tls.server)}; client=${btoa(endpoint.tls.client.cert + endpoint.tls.client.key)}`
    : `address=${endpoint.address}; secret=${endpoint.secret}`;

/**
 * Names for `paths` in a directory of their own, until `release` is called: each a VFS path, or a
 * path on disk the caller made itself, which is what it stands for when it is not a node. The
 * names are served once this settles, and no longer once `release`'s promise has.
 */
export const grant = async (
  cmd: Pick<Command, 'sys' | 'access'>,
  paths: { path: string; mode: Named['mode'] }[],
): Promise<{ names: string[]; release: () => Promise<void> }> => {
  const directory = `/${hex(16)}`;
  const set: [string, Named][] = [];
  for (const [index, { path, mode }] of paths.entries()) {
    let named: Named = { mode, disk: path };
    try {
      const physical = (await cmd.sys.vfs.stat(cmd.access, path)).path;
      if (typeof physical === 'string' && physical) {
        named = { mode, disk: physical };
      } else {
        // A node with no file on disk: the db tier, or a stream, which is read or written as it comes.
        const stream = await cmd.sys.vfs.get(cmd.access, path).then((node) => node.type === 'stream', () => false);
        named = { mode, node: path, ...(stream ? { stream: true as const } : {}) };
      }
    } catch {
      // Not a node: a file on disk.
    }
    set.push([`${directory}/${index}-${basename(path) || 'file'}`, named]);
  }
  await changeNames({ set, grants: [directory] });
  const made = set.map(([name]) => name);
  let released: Promise<void> | undefined;
  return {
    names: made,
    release: () => released ??= changeNames({ ended: made, ungrants: [directory] }),
  };
};

/**
 * For one request to `emsUrl`: the body to send, each `file.path`, `mask.path` and `source.path` (read) and
 * `output.path` or `output.<name>.path` (written) in it at any depth replaced by its name, the header naming the
 * endpoint, and `release`, which ends the names. A body that names no file goes as it is; one that does, when
 * nothing serves `emsUrl` its files, is undefined.
 */
export const forRequest = async <T>(
  cmd: Pick<Command, 'sys' | 'access'>,
  emsUrl: string,
  body: T,
): Promise<{ body: T; headers: Record<string, string>; release: () => Promise<void> } | undefined> => {
  const paths: { path: string; mode: Named['mode'] }[] = [];
  const refs: Record<string, unknown>[] = [];
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = copy(child);
      const ref = out[key] as Record<string, unknown>;
      if ((key === 'file' || key === 'mask' || key === 'source' || key === 'output') && ref && typeof ref === 'object' && typeof ref.path === 'string') {
        paths.push({ path: ref.path, mode: key === 'output' ? 'write' : 'read' });
        refs.push(ref);
      } else if (key === 'output' && ref && typeof ref === 'object' && !Array.isArray(ref)) {
        // Several outputs by name, as a page's formats.
        for (const each of Object.values(ref)) {
          if (!each || typeof each !== 'object' || typeof (each as Record<string, unknown>).path !== 'string') continue;
          paths.push({ path: (each as Record<string, string>).path, mode: 'write' });
          refs.push(each as Record<string, unknown>);
        }
      }
    }
    return out;
  };
  const sent = copy(body) as T;
  if (paths.length === 0) return { body, headers: {}, release: () => Promise.resolve() };
  const endpoint = filesState().endpoints.get(emsUrl);
  if (!endpoint) return undefined;
  const { names, release } = await grant(cmd, paths);
  refs.forEach((ref, index) => ref.path = names[index]);
  return { body: sent, headers: { 'ems-files': headerValue(endpoint) }, release };
};

/**
 * For what `emsUrl` runs as `slot` (`watches/<id>`, `pages/<id>`): its body with each file's path
 * replaced by a name granted for as long as it runs, and the header naming the endpoint. The same
 * body stated again to the same endpoint keeps its names, so the media service sees the same thing
 * and leaves it running; another body, or an endpoint started anew, is granted new names, and
 * `settled`, once the media service has been told, ends the old ones. Undefined when nothing serves
 * `emsUrl` its files.
 */
export const forRunning = async <T>(
  cmd: Pick<Command, 'sys' | 'access'>,
  emsUrl: string,
  slot: string,
  body: T,
): Promise<{ body: T; headers: Record<string, string>; settled: () => Promise<void> } | undefined> => {
  const { endpoints, running } = filesState();
  const endpoint = endpoints.get(emsUrl);
  if (!endpoint) return undefined;
  const key = `${headerValue(endpoint)}\n${JSON.stringify(body)}`;
  const held = running.get(`${emsUrl} ${slot}`);
  if (held?.key === key) return { body: held.body as T, headers: held.headers, settled: () => Promise.resolve() };
  const granted = await forRequest(cmd, emsUrl, body);
  if (!granted) return undefined;
  running.set(`${emsUrl} ${slot}`, { key, body: granted.body, headers: granted.headers, release: granted.release });
  return { body: granted.body, headers: granted.headers, settled: async () => await held?.release() };
};

/** What `emsUrl` ran as `slot` stopped: the names it was granted end. */
export const endRunning = async (emsUrl: string, slot: string): Promise<void> => {
  const { running } = filesState();
  const held = running.get(`${emsUrl} ${slot}`);
  running.delete(`${emsUrl} ${slot}`);
  await held?.release();
};
