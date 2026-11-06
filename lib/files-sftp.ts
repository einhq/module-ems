/**
 * The SFTP session of `ems-files`: the paths granted to requests in flight (`granted`) and nothing
 * else.
 *
 * A path is a file on this host's disk, opened as named and following its links, so an original
 * kept elsewhere is read where its bytes are. An input opens read-only. An output opens write-only
 * and is written in place, truncated first: a client that writes through a mount (sshfs) has its
 * writes on disk when its close returns, while the SFTP close may come later, so nothing waits for
 * that close. A file in a granted directory is written the same way, the directory made when
 * missing or asked for. A directory is never listed, and nothing is removed, renamed, linked or changed in its
 * attributes: each of those is refused.
 *
 * A grant is checked when a path is opened or stat'ed; a handle already open stays usable after its
 * request ends, until the client closes it or the session ends.
 */

import { dirname } from '@std/path/posix';
import { OPEN_MODE, type SFTP, STATUS_CODE } from 'ssh2';
import { canonical, granted, grantedDirectory } from './files.ts';

/** The most a READ answers with, what OpenSSH's own server allows. */
const MAX_READ = 256 * 1024 - 2 * 1024;

/** The most one file call reads or writes for a run of neighbouring requests. */
const MAX_RUN = 4 * 1024 * 1024;

type ReadRequest = { op: 'read'; reqId: number; offset: number; length: number };
type WriteRequest = { op: 'write'; reqId: number; offset: number; data: Uint8Array };
type Queued = ReadRequest | WriteRequest | { op: 'other'; run: () => Promise<void> };

/**
 * An open file and the requests waiting on it. They run in order, one file call at a time, and
 * READs or WRITEs that follow on from each other share one call: a client keeps dozens in flight,
 * and each awaited call costs a turn of the event loop whatever its size.
 */
type Open = {
  file: Deno.FsFile;
  position: number;
  queued: Queued[];
  draining: boolean;
} & { kind: 'read' | 'write' };

/** The answers a session sends, which go nowhere once it has ended. */
type Replies = Pick<SFTP, 'status' | 'handle' | 'data' | 'attrs' | 'name'>;

const sizeOf = (request: ReadRequest | WriteRequest): number => (request.op === 'read' ? request.length : request.data.length);

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const seconds = (time: Date | null): number => Math.floor((time?.getTime() ?? 0) / 1000);

const attrsOf = (info: Deno.FileInfo) => ({
  mode: (info.isDirectory ? S_IFDIR : S_IFREG) | ((info.mode ?? 0o644) & 0o777),
  uid: 0,
  gid: 0,
  size: info.size,
  atime: seconds(info.atime ?? info.mtime),
  mtime: seconds(info.mtime),
});

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

  constructor(private log: (line: string) => void = () => {}) {}

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
    sftp.on('REALPATH', (reqId: number, path: string) => void this.realpath(reqId, path));
    sftp.on('OPENDIR', (reqId: number) => this.refuse(reqId, 'listing'));
    sftp.on('MKDIR', (reqId: number, path: string) => void this.mkdir(reqId, path));
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
    if (entry.position !== offset) entry.position = await entry.file.seek(offset, Deno.SeekMode.Start);
  }

  private async open(reqId: number, filename: string, flags: number): Promise<void> {
    const path = canonical(filename);
    const writing = (flags & OPEN_MODE.WRITE) !== 0;
    const reading = (flags & OPEN_MODE.READ) !== 0;
    if (!path || reading === writing) return this.refuse(reqId, `open ${filename}`);
    try {
      if (reading) {
        if (!granted(path, 'read')) return this.refuse(reqId, `read ${path}`);
        const file = await Deno.open(path, { read: true });
        this.out.handle(reqId, this.keep({ kind: 'read', file, position: 0, queued: [], draining: false }));
        return;
      }
      if (!granted(path, 'write')) return this.refuse(reqId, `write ${path}`);
      const directory = dirname(path);
      if (grantedDirectory(directory)) await Deno.mkdir(directory, { recursive: true });
      const file = await Deno.open(path, { write: true, create: true, truncate: true });
      this.out.handle(reqId, this.keep({ kind: 'write', file, position: 0, queued: [], draining: false }));
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
        const n = await entry.file.read(buffer.subarray(got));
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
      while (done < data.length) done += await entry.file.write(data.subarray(done));
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
      this.out.attrs(reqId, attrsOf(await entry.file.stat()));
    } catch (error) {
      this.out.status(reqId, statusOf(error));
    }
  }

  private async stat(reqId: number, filename: string): Promise<void> {
    const path = canonical(filename);
    if (!path || !granted(path, 'stat')) return this.refuse(reqId, `stat ${filename}`);
    try {
      this.out.attrs(reqId, attrsOf(await Deno.stat(path)));
    } catch (error) {
      this.out.status(reqId, statusOf(error));
    }
  }

  /**
   * A granted path with its links resolved, so the client learns an original's own name; any other
   * path only in its one spelling, which says nothing of whether it exists.
   */
  private async realpath(reqId: number, filename: string): Promise<void> {
    let path = canonical(filename.startsWith('/') ? filename : `/${filename}`) ?? '/';
    if (granted(path, 'stat')) path = await Deno.realPath(path).catch(() => path);
    this.out.name(reqId, { filename: path, longname: path, attrs: {} });
  }

  /** A granted directory made, with what is missing above it; any other is refused. */
  private async mkdir(reqId: number, filename: string): Promise<void> {
    const path = canonical(filename);
    if (!path || !grantedDirectory(path)) return this.refuse(reqId, `mkdir ${filename}`);
    try {
      await Deno.mkdir(path, { recursive: true });
      this.out.status(reqId, STATUS_CODE.OK);
    } catch (error) {
      this.out.status(reqId, statusOf(error));
    }
  }

  private async close(reqId: number, entry: Open): Promise<void> {
    try {
      entry.file.close();
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
      const discard = () => {
        try {
          entry.file.close();
        } catch {
          // Closed already.
        }
        resolve();
        return Promise.resolve();
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
