/**
 * `ems-files`'s server, as EiN's thread runs it: the SSH server itself runs on a worker
 * (files-thread.ts), so the media service's reads and writes never wait for EiN's event loop.
 *
 * This side publishes the endpoint, keeps the worker's copy of the names (every grant waits until
 * the worker has it), and answers the worker's calls on nodes with no file on disk through the
 * VFS. A worker that dies settles `failed`, and nothing is served from then on.
 */

import { FILES_USER } from './files-ssh.ts';
import type { NodeAccess, NodeHandle } from './files-sftp.ts';
import { type FilesEndpoint, filesState, type NamesMirror } from './files.ts';
import { type FromThread, type NodeCall, THREAD_URL, type ToThread } from './files-thread.ts';

export { FILES_USER };

type FilesServerOptions = {
  /** The port to listen on, 0 for any. */
  port: number;
  /** `host:port` as EMS reaches this server; a port of its own when the listener is behind a mapping. */
  address: string;
  /** The media service the names are for. */
  emsUrl: string;
  /** The VFS, for the names of nodes with no file on disk. */
  nodes: NodeAccess;
  log?: (line: string) => void;
};

export class FilesServer {
  private worker?: Worker;
  private endpoint?: FilesEndpoint;
  private mirror?: NamesMirror;
  private listening?: PromiseWithResolvers<{ port: number; secret: string; hostKey: string }>;
  private stopped?: PromiseWithResolvers<void>;
  private acks = new Map<number, () => void>();
  private nextAck = 1;
  private handles = new Map<number, NodeHandle>();
  private nextHandle = 1;
  private failure = Promise.withResolvers<Error>();

  /** Settles when the worker ends without being stopped, with why. */
  readonly failed: Promise<Error> = this.failure.promise;

  constructor(private options: FilesServerOptions) {}

  /** Start the worker, listen, and publish the endpoint to the client; the port actually listened on. */
  async start(): Promise<number> {
    const worker = new Worker(THREAD_URL, { type: 'module' });
    this.worker = worker;
    this.listening = Promise.withResolvers();
    worker.onmessage = ({ data }: MessageEvent<FromThread>) => this.message(data);
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      this.fail(new Error(`ems-files thread: ${event.message}`));
    };
    const { names, grants, mirrors } = filesState();
    // The copy starts with the names granted so far; the changes after follow it in order.
    this.post({ op: 'start', port: this.options.port, names: { set: [...names], grants: [...grants] } });
    this.mirror = (change) => {
      const seq = this.nextAck++;
      const { promise, resolve } = Promise.withResolvers<void>();
      this.acks.set(seq, resolve);
      this.post({ op: 'names', seq, change });
      return promise;
    };
    mirrors.add(this.mirror);
    const { port, secret, hostKey } = await this.listening.promise;
    this.endpoint = { address: this.options.address, emsUrl: this.options.emsUrl, user: FILES_USER, secret, hostKey };
    filesState().endpoints.set(this.options.emsUrl, this.endpoint);
    return port;
  }

  async stop(): Promise<void> {
    if (!this.worker) return;
    this.unpublish();
    this.stopped = Promise.withResolvers();
    this.post({ op: 'stop' });
    // The sessions close their node handles through this thread while they stop.
    await Promise.race([this.stopped.promise, this.failed]);
    this.end();
  }

  private post(message: ToThread, transfer: Transferable[] = []): void {
    this.worker?.postMessage(message, transfer);
  }

  private message(data: FromThread): void {
    switch (data.op) {
      case 'listening':
        return this.listening?.resolve(data);
      case 'failed':
        return this.fail(new Error(data.message));
      case 'names':
        this.acks.get(data.seq)?.();
        this.acks.delete(data.seq);
        return;
      case 'log':
        return this.options.log?.(data.line);
      case 'node':
        return void this.node(data.id, data);
      case 'stopped':
        return this.stopped?.resolve();
    }
  }

  private async node(id: number, call: NodeCall): Promise<void> {
    try {
      const { value, transfer } = await this.call(call);
      this.post({ op: 'answer', id, value }, transfer);
    } catch (error) {
      const { name, message } = error instanceof Error ? error : new Error(String(error));
      this.post({ op: 'answer', id, error: { name, message } });
    }
  }

  private async call(call: NodeCall): Promise<{ value: unknown; transfer?: Transferable[] }> {
    if (call.call === 'open') {
      const id = this.nextHandle++;
      this.handles.set(id, await this.options.nodes.open(call.path, call.mode));
      return { value: id };
    }
    if (call.call === 'stat') return { value: await this.options.nodes.stat(call.path) };
    const handle = this.handles.get(call.handle);
    if (!handle) throw new Error('ems-files: no such node handle');
    switch (call.call) {
      case 'seek':
        return { value: await handle.seek(call.offset, 0) };
      case 'read': {
        // A copy of the bytes read alone: the handle may answer with a view of a larger buffer.
        const data = (await handle.read(call.size)).slice();
        return { value: data, transfer: [data.buffer] };
      }
      case 'write':
        return { value: await handle.write(call.data) };
      case 'size':
        return { value: await handle.size() };
      case 'close':
        this.handles.delete(call.handle);
        await handle.close();
        return { value: undefined };
    }
  }

  private unpublish(): void {
    const { endpoints, mirrors } = filesState();
    if (this.endpoint && endpoints.get(this.options.emsUrl) === this.endpoint) endpoints.delete(this.options.emsUrl);
    if (this.mirror) mirrors.delete(this.mirror);
  }

  /** Stop the worker and let go of what it held: grants waiting on it go on, its node handles close. */
  private end(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const ack of this.acks.values()) ack();
    this.acks.clear();
    for (const handle of this.handles.values()) void handle.close().catch(() => {});
    this.handles.clear();
  }

  private fail(error: Error): void {
    if (!this.worker) return;
    this.unpublish();
    this.end();
    this.listening?.reject(error);
    this.failure.resolve(error);
  }
}
