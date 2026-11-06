/**
 * EiN's files for a media service that does not mount them: which paths a request may touch, and
 * where the service reaches them.
 *
 * EMS opens the physical paths a request names. Beside EiN it mounts the same file tiers at the
 * same paths; on another host it has none of them. The `ems-files` service then serves them over
 * SFTP, and only the paths of the requests in flight: an input to read, an output to write, each
 * for as long as its request runs, and nothing to list. `forRequest` grants a request body's paths
 * and names the endpoint in the `EMS-Files` header; the client holds the grant until the answer
 * is read.
 *
 * The state hangs off `globalThis` rather than this file: a module's files are loaded once per
 * process per content, so a daemon started before a module update and a bin loaded after it run
 * different copies of this file, and must still share one set of grants.
 */

import { dirname, normalize } from '@std/path/posix';

/**
 * What a path is granted for, as counts, since several requests in flight may name the same file:
 * `read` an input, `write` an output file, `files` a directory whose files may be written.
 */
type Grant = { read: number; write: number; files: number };

/** The endpoint while `ems-files` serves, as the client names it to EMS. */
export type FilesEndpoint = {
  /** `host:port`, as EMS reaches this endpoint. */
  address: string;
  /** The media service the grants are for: the system's own (`CFG_EMS_URL` of the service). */
  emsUrl: string;
  user: string;
  /** The password of `user`, made when the service starts and good until it stops. */
  secret: string;
  /** The host key's public half, `ssh-ed25519 AAAA…`, which EMS pins. */
  hostKey: string;
};

type FilesState = { endpoint?: FilesEndpoint; grants: Map<string, Grant> };

const STATE = Symbol.for('ein.ems.files');

export const filesState = (): FilesState => {
  const global = globalThis as unknown as Record<symbol, FilesState | undefined>;
  return global[STATE] ??= { grants: new Map() };
};

/** The paths an EMS request body names. */
export type RequestPaths = { read: string[]; write: string[]; dirs: string[] };

/** An absolute path in its one spelling, or undefined for anything else. */
export const canonical = (path: string): string | undefined => (path.startsWith('/') ? normalize(path) : undefined);

/**
 * Every path in a request body, at any depth: a `file`'s `path` is read, an `output`'s `path` is
 * written and an `output`'s `dir` gets files written into it (`targets[].output` included).
 */
export const requestPaths = (body: unknown): RequestPaths => {
  const paths: RequestPaths = { read: [], write: [], dirs: [] };
  const add = (list: string[], value: unknown) => {
    const path = typeof value === 'string' ? canonical(value) : undefined;
    if (path) list.push(path);
  };
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const ref = child as Record<string, unknown>;
        if (key === 'file') add(paths.read, ref.path);
        if (key === 'output') {
          add(paths.write, ref.path);
          add(paths.dirs, ref.dir);
        }
      }
      walk(child);
    }
  };
  walk(body);
  return paths;
};

/** Grant `paths` until the returned function is called; calling it again does nothing. */
export const grant = (paths: RequestPaths): () => void => {
  const grants = filesState().grants;
  const taken: [string, keyof Grant][] = [
    ...paths.read.map((path) => [path, 'read'] as [string, keyof Grant]),
    ...paths.write.map((path) => [path, 'write'] as [string, keyof Grant]),
    ...paths.dirs.map((path) => [path, 'files'] as [string, keyof Grant]),
  ];
  for (const [path, kind] of taken) {
    const entry = grants.get(path) ?? { read: 0, write: 0, files: 0 };
    entry[kind] += 1;
    grants.set(path, entry);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const [path, kind] of taken) {
      const entry = grants.get(path);
      if (!entry) continue;
      entry[kind] -= 1;
      if (entry.read + entry.write + entry.files <= 0) grants.delete(path);
    }
  };
};

/**
 * Whether a canonical path may be opened to `read` or to `write`, or have its attributes read
 * (`stat`): an input is read, an output or a file in a granted directory written, and anything
 * granted, a granted directory itself too, may be stat'ed.
 */
export const granted = (path: string, want: 'read' | 'write' | 'stat'): boolean => {
  const grants = filesState().grants;
  const entry = grants.get(path);
  if (want === 'read') return (entry?.read ?? 0) > 0;
  const inDirectory = (grants.get(dirname(path))?.files ?? 0) > 0;
  if (want === 'write') return (entry?.write ?? 0) > 0 || inDirectory;
  return entry !== undefined || inDirectory;
};

/** Whether a canonical path is a directory granted to have files written into it. */
export const grantedDirectory = (path: string): boolean => (filesState().grants.get(path)?.files ?? 0) > 0;

/** `EMS-Files`'s value: `address=…; user=…; secret=…; hostkey=…`. */
export const headerValue = (endpoint: FilesEndpoint): string => `address=${endpoint.address}; user=${endpoint.user}; secret=${endpoint.secret}; hostkey=${endpoint.hostKey}`;

/**
 * For one request to `emsUrl`: the header naming the endpoint and the grant of the body's paths,
 * which `release` ends. Nothing is granted and no header sent while `ems-files` does not serve,
 * or when the request goes to another media service than the one it serves.
 */
export const forRequest = (emsUrl: string, body: unknown): { headers: Record<string, string>; release: () => void } => {
  const endpoint = filesState().endpoint;
  if (!endpoint || endpoint.emsUrl !== emsUrl) return { headers: {}, release: () => {} };
  return { headers: { 'ems-files': headerValue(endpoint) }, release: grant(requestPaths(body)) };
};
