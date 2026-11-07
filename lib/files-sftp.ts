/**
 * The SFTP session of `ems-files`: the names of the requests in flight (`lookup`) and nothing else.
 *
 * `/` and each request's directory are directories, which may be stat'ed and never listed; every
 * other path is one of a request's names or does not exist. A name stands for a file on this host's
 * disk, opened as it is and following its links, or a node of the VFS with no file on disk. An
 * input opens read-only. An output opens write-only and is written in place, truncated first: a
 * client that writes through a mount (sshfs) has its writes there when its close returns, while
 * the SFTP close may come later, so nothing waits for that close. Nothing is removed, renamed,
 * linked or changed in its attributes: each of those is refused.
 *
 * A name is looked up when it is opened or stat'ed; a handle already open stays usable after its
 * request ends, until the client closes it or the session ends.
 */

import type { ResourceHandleIf } from '@ein/client';
import { OPEN_MODE, type SFTP, STATUS_CODE } from 'ssh2';
import { canonical, lookup, type Named } from './files.ts';

/** The most a READ answers with, what OpenSSH's own server allows. */
const MAX_READ = 256 * 1024 - 2 * 1024;

/** The most one file call reads or writes for a run of neighbouring requests. */
const MAX_RUN = 4 * 1024 * 1024;

/** The VFS, for the names that stand for a node with no file on disk. */
export type NodeAccess = {
  open(path: string, mode: Named['mode']): Promise<ResourceHandleIf>;
  stat(path: string): Promise<{ size: number; mtime?: number }>;
};

/** An open file, on disk or in the VFS, as the session reads and writes it. */
type Body = {
  seek(offset: number): Promise<void>;
  read(into: Uint8Array): Promise<number | null>;
  write(data: Uint8Array): Promise<number>;
  size(): Promise<number>;
  close(): Promise<void>;
};

const diskBody = async (path: string, mode: Named['mode']): Promise<Body> => {
  const file = await Deno.open(path, mode === 'read' ? { read: true } : { write: true, create: true, truncate: true });
  return {
    seek: async (offset) => void await file.seek(offset, Deno.SeekMode.Start),
    read: (into) => file.read(into),
    write: (data) => file.write(data),
    size: async () => (await file.stat()).size,
    close: () => Promise.resolve(file.close()),
  };
};

const nodeBody = (handle: ResourceHandleIf): Body => ({
  seek: async (offset) => void await handle.seek(offset, 0),
  read: async (into) => {
    const data = await handle.read(into.length);
    if (data.length === 0) return null;
    into.set(data);
    return data.length;
  },
  write: (data) => handle.write(data),
  size: () => handle.size(),
  close: () => handle.close(),
});

type ReadRequest = { op: 'read'; reqId: number; offset: number; length: number };
type WriteRequest = { op: 'write'; reqId: number; offset: number; data: Uint8Array };
type Queued = ReadRequest | WriteRequest | { op: 'other'; run: () => Promise<void> };

/**
 * An open file and the requests waiting on it. They run in order, one file call at a time, and
 * READs or WRITEs that follow on from each other share one call: a client keeps dozens in flight,
 * and each awaited call costs a turn of the event loop whatever its size.
 */
type Open = {
  kind: Named['mode'];
  body: Body;
  position: number;
  queued: Queued[];
  draining: boolean;
};

/** The answers a session sends, which go nowhere once it has ended. */
type Replies = Pick<SFTP, 'status' | 'handle' | 'data' | 'attrs' | 'name'>;

const sizeOf = (request: ReadRequest | WriteRequest): number => (request.op === 'read' ? request.length : request.data.length);

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const attrs = (directory: boolean, size: number, mtime: number) => {
  const seconds = Math.floor(mtime / 1000);
  return { mode: directory ? S_IFDIR | 0o755 : S_IFREG | 0o644, uid: 0, gid: 0, size, atime: seconds, mtime: seconds };
};

/** The SFTP status a failed file operation answers with. */
const statusOf = (error: unknown): number => {
  if (error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory) return STATUS_CODE.NO_SUCH_FILE;
  if (error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.IsADirectory) return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
};

/** One SFTP session's handles; `attach` wires it to the session and cleans up when it ends. */
export class FilesSession {
  private handles = new Map<number, Open>();
  private nextHandle = 1;
  private ended = false;
  private out: Replies = { status: () => {}, handle: () => {}, data: () => {}, attrs: () => {}, name: () => {} };

  constructor(private nodes: NodeAccess, private log: (line: string) => void = () => {}) {}

  attach(sftp: SFTP): void {
    const live = <A extends unknown[]>(send: (...args: A) => void) => (...args: A) => {
      if (!this.ended) send(...args);
    };
    this.out = {
      status: live(sftp.status.bind(sftp)),
      handle: live(sftp.handle.bind(sftp)),
      data: live(sftp.data.bind(sftp)),
      attrs: live(sftp.attrs.bind(sftp)),
      name: live(sftp.name.bind(sftp)),
    };
    const end = () => void this.closeAll();
    sftp.on('close', end);
    sftp.on('end', end);
    sftp.on('error', end);

    sftp.on('OPEN', (reqId: number, filename: string, flags: number) => void this.open(reqId, filename, flags));
    // A request's handle is a view of a buffer the next packet may overwrite, so it is looked up
    // as the request arrives.
    sftp.on('READ', (reqId: number, handle: Uint8Array, offset: number | bigint, length: number) => {
      this.enqueue(reqId, this.handleOf(handle), 'read', { op: 'read', reqId, offset: Number(offset), length: Math.min(length, MAX_READ) });
    });
    sftp.on('WRITE', (reqId: number, handle: Uint8Array, offset: number | bigint, data: Uint8Array) => {
      this.enqueue(reqId, this.handleOf(handle), 'write', { op: 'write', reqId, offset: Number(offset), data });
    });
    sftp.on('FSTAT', (reqId: number, handle: Uint8Array) => {
      const entry = this.handleOf(handle);
      this.enqueue(reqId, entry, undefined, { op: 'other', run: () => this.fstat(reqId, entry!) });
    });
    sftp.on('CLOSE', (reqId: number, handle: Uint8Array) => {
      const entry = this.handleOf(handle);
      if (entry) this.handles.delete(this.idOf(handle)!);
      this.enqueue(reqId, entry, undefined, { op: 'other', run: () => this.close(reqId, entry!) });
    });
    sftp.on('STAT', (reqId: number, path: string) => void this.stat(reqId, path));
    sftp.on('LSTAT', (reqId: number, path: string) => void this.stat(reqId, path));
    // A client asks where it is before anything else; the answer reveals nothing.
    sftp.on('REALPATH', (reqId: number, path: string) => {
      const resolved = canonical(path.startsWith('/') ? path : `/${path}`) ?? '/';
      this.out.name(reqId, { filename: resolved, longname: resolved, attrs: {} });
    });
    sftp.on('OPENDIR', (reqId: number) => this.refuse(reqId, 'listing'));
  }

  private refuse(reqId: number, what: string): void {
    this.log(`ems-files: refused ${what}`);
    this.out.status(reqId, STATUS_CODE.PERMISSION_DENIED);
  }

  private idOf(handle: Uint8Array): number | undefined {
    return handle.length === 4 ? new DataView(handle.buffer, handle.byteOffset, 4).getUint32(0) : undefined;
  }

  private handleOf(handle: Uint8Array): Open | undefined {
    const id = this.idOf(handle);
    return id === undefined ? undefined : this.handles.get(id);
  }

  private keep(entry: Open): Uint8Array {
    const id = this.nextHandle++;
    this.handles.set(id, entry);
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, id);
    return buf;
  }

  /** Queue a request on its handle, refusing it at once when the handle is not one of kind `kind`. */
  private enqueue(reqId: number, entry: Open | undefined, kind: Open['kind'] | undefined, request: Queued): void {
    if (!entry || (kind && entry.kind !== kind)) return this.out.status(reqId, STATUS_CODE.FAILURE, 'invalid handle');
    entry.queued.push(request);
    if (entry.draining) return;
    entry.draining = true;
    // Started once the packets that came together have all been queued.
    queueMicrotask(() => void this.drain(entry));
  }

  private async drain(entry: Open): Promise<void> {
    try {
      while (entry.queued.length > 0) {
        const batch = entry.queued.splice(0);
        for (let i = 0; i < batch.length;) {
          const first = batch[i];
          if (first.op === 'other') {
            await first.run();
            i++;
            continue;
          }
          let end = first.offset + sizeOf(first);
          let j = i + 1;
          for (; j < batch.length; j++) {
            const next = batch[j];
            if (next.op !== first.op || next.offset !== end || end + sizeOf(next) - first.offset > MAX_RUN) break;
            end += sizeOf(next);
          }
          // Once the session has ended nobody waits for a read or a write.
          if (!this.ended) {
            const run = batch.slice(i, j);
            if (first.op === 'read') await this.readRun(entry, run as ReadRequest[]);
            else await this.writeRun(entry, run as WriteRequest[]);
          }
          i = j;
        }
      }
    } finally {
      entry.draining = false;
    }
  }

  private async seek(entry: Open, offset: number): Promise<void> {
    if (entry.position === offset) return;
    await entry.body.seek(offset);
    entry.position = offset;
  }

  private async open(reqId: number, filename: string, flags: number): Promise<void> {
    const path = canonical(filename);
    const writing = (flags & OPEN_MODE.WRITE) !== 0;
    const reading = (flags & OPEN_MODE.READ) !== 0;
    const named = path ? lookup(path) : undefined;
    const mode = reading ? 'read' : 'write';
    if (!named || named === 'directory' || reading === writing || named.mode !== mode) return this.refuse(reqId, `open ${filename}`);
    try {
      const body = named.disk ? await diskBody(named.disk, mode) : nodeBody(await this.nodes.open(named.node!, mode));
      this.out.handle(reqId, this.keep({ kind: mode, body, position: 0, queued: [], draining: false }));
    } catch (error) {
      this.out.status(reqId, statusOf(error));
    }
  }

  /** READs of neighbouring ranges, read with one call and answered from it; past the end is EOF. */
  private async readRun(entry: Open, run: ReadRequest[]): Promise<void> {
    const start = run[0].offset;
    const buffer = new Uint8Array(run.reduce((total, request) => total + request.length, 0));
    let got = 0;
    try {
      await this.seek(entry, start);
      while (got < buffer.length) {
        const n = await entry.body.read(buffer.subarray(got));
        if (n === null) break;
        got += n;
      }
      entry.position = start + got;
    } catch (error) {
      entry.position = -1;
      for (const request of run) this.out.status(request.reqId, statusOf(error));
      return;
    }
    for (const request of run) {
      const from = request.offset - start;
      const length = Math.max(0, Math.min(request.length, got - from));
      if (length === 0) this.out.status(request.reqId, STATUS_CODE.EOF);
      else this.out.data(request.reqId, buffer.subarray(from, from + length));
    }
  }

  /** WRITEs of neighbouring ranges, written with one call. */
  private async writeRun(entry: Open, run: WriteRequest[]): Promise<void> {
    let data = run[0].data;
    if (run.length > 1) {
      data = new Uint8Array(run.reduce((total, request) => total + request.data.length, 0));
      let at = 0;
      for (const request of run) {
        data.set(request.data, at);
        at += request.data.length;
      }
    }
    try {
      await this.seek(entry, run[0].offset);
      let done = 0;
      while (done < data.length) done += await entry.body.write(data.subarray(done));
      entry.position = run[0].offset + done;
    } catch (error) {
      entry.position = -1;
      for (const request of run) this.out.status(request.reqId, statusOf(error));
      return;
    }
    for (const request of run) this.out.status(request.reqId, STATUS_CODE.OK);
  }

  private async fstat(reqId: number, entry: Open): Promise<void> {
    try {
      this.out.attrs(reqId, attrs(false, await entry.body.size(), Date.now()));
    } catch (error) {
      this.out.status(reqId, statusOf(error));
    }
  }

  private async stat(reqId: number, filename: string): Promise<void> {
    const path = canonical(filename);
    const named = path ? lookup(path) : undefined;
    if (!named) return this.refuse(reqId, `stat ${filename}`);
    try {
      if (named === 'directory') return this.out.attrs(reqId, attrs(true, 0, Date.now()));
      if (named.disk) {
        const info = await Deno.stat(named.disk);
        return this.out.attrs(reqId, attrs(false, info.size, info.mtime?.getTime() ?? 0));
      }
      const info = await this.nodes.stat(named.node!);
      this.out.attrs(reqId, attrs(false, info.size, info.mtime ?? 0));
    } catch (error) {
      this.out.status(reqId, statusOf(error));
    }
  }

  private async close(reqId: number, entry: Open): Promise<void> {
    try {
      await entry.body.close();
      this.out.status(reqId, STATUS_CODE.OK);
    } catch (error) {
      this.out.status(reqId, statusOf(error));
    }
  }

  /** End the session: each handle it left open is closed after what it queued. */
  async closeAll(): Promise<void> {
    this.ended = true;
    const left = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(left.map((entry) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const discard = async () => {
        await entry.body.close().catch(() => {});
        resolve();
      };
      entry.queued.push({ op: 'other', run: discard });
      if (!entry.draining) {
        entry.draining = true;
        void this.drain(entry);
      }
      return promise;
    }));
  }
}
