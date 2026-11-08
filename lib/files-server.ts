/**
 * `ems-files`'s server, as EiN's thread runs it: a thread listens and carries each connection's
 * bytes (files-listen.ts), and up to `SESSION_THREADS` threads serve them (files-thread.ts), so the
 * media service's reads and writes never wait for EiN's event loop, and several connections are
 * served on several CPUs.
 *
 * This side makes the credentials, publishes the endpoint, starts a session thread whenever the
 * listening thread asks for one, keeps each session thread's copy of the names (every grant waits
 * until all have it), and answers their calls on nodes with no file on disk through the VFS. A thread that
 * dies settles `failed`, and nothing is served from then on.
 */

import { makeTls } from './files-cert.ts';
import type { NodeAccess, NodeHandle } from './files-sftp.ts';
import { type FilesEndpoint, filesState, type NamesMirror } from './files.ts';
import { type Auth, type FromListen, LISTEN_URL, type ToListen } from './files-listen.ts';
import { type FromThread, type NodeCall, THREAD_URL, type ToThread } from './files-thread.ts';

/** The most threads that serve connections; the media service mounts with as many connections. */
const SESSION_THREADS = 4;

type FilesServerOptions = {
  /** The port to listen on, 0 for any. */
  port: number;
  /** `host:port` as EMS reaches this server; a port of its own when the listener is behind a mapping. */
  address: string;
  /** The media service the names are for; `publish` adds others. */
  emsUrl: string;
  /** Whether connections are TLS, each side pinning the other's certificate, rather than plain. */
  tls?: boolean;
  /** The VFS, for the names of nodes with no file on disk. */
  nodes: NodeAccess;
  log?: (line: string) => void;
};

/** What a worker's events throw would end EiN's process, not this service: it is logged. */
const guarded = (log: ((line: string) => void) | undefined, run: () => void): void => {
  try {
    run();
  } catch (error) {
    log?.(`ems-files: ${error instanceof Error ? error.message : error}`);
  }
};

/** A session thread: its copy of the names, and the node handles its calls opened. */
class SessionThread {
  private worker: Worker;
  private mirror: NamesMirror;
  private acks = new Map<number, () => void>();
  private nextAck = 1;
  private handles = new Map<number, NodeHandle>();
  private nextHandle = 1;
  private started = Promise.withResolvers<void>();
  private stopped = Promise.withResolvers<void>();

  constructor(link: MessagePort, private options: FilesServerOptions, private fail: (error: Error) => void) {
    this.worker = new Worker(THREAD_URL, { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<FromThread>) => guarded(options.log, () => this.message(data));
    this.worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      guarded(options.log, () => fail(new Error(`ems-files thread: ${event.message}`)));
    };
    const { names, grants, mirrors } = filesState();
    // The copy starts with the names granted so far; the changes after follow it in order.
    this.post({ op: 'start', names: { set: [...names], grants: [...grants] }, link }, [link]);
    this.mirror = (change) => {
      const seq = this.nextAck++;
      const { promise, resolve } = Promise.withResolvers<void>();
      this.acks.set(seq, resolve);
      this.post({ op: 'names', seq, change });
      return promise;
    };
    mirrors.add(this.mirror);
  }

  /** Settles once the thread serves, rejects when it cannot. */
  get ready(): Promise<void> {
    return this.started.promise;
  }

  /** Ask the thread to stop, which closes its sessions and their node handles through this one. */
  stop(): Promise<void> {
    filesState().mirrors.delete(this.mirror);
    this.post({ op: 'stop' });
    return this.stopped.promise;
  }

  /** Let go of the thread and what it held: grants waiting on it go on, its node handles close. */
  end(): void {
    filesState().mirrors.delete(this.mirror);
    this.worker.terminate();
    for (const ack of this.acks.values()) ack();
    this.acks.clear();
    for (const handle of this.handles.values()) void handle.close().catch(() => {});
    this.handles.clear();
    this.started.reject(new Error('ems-files: stopped'));
    this.started.promise.catch(() => {});
    this.stopped.resolve();
  }

  private post(message: ToThread, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private message(data: FromThread): void {
    switch (data.op) {
      case 'started':
        return this.started.resolve();
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
        return this.stopped.resolve();
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
    const { nodes } = this.options;
    if (call.call === 'open') {
      const id = this.nextHandle++;
      this.handles.set(id, await nodes.open(call.path, call.mode));
      return { value: id };
    }
    if (call.call === 'stat') return { value: await nodes.stat(call.path) };
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
}

export class FilesServer {
  private listener?: Worker;
  private sessions: SessionThread[] = [];
  private credentials?: Pick<FilesEndpoint, 'secret' | 'tls'>;
  /** The endpoints this server published, by the media service each is for. */
  private published = new Map<string, FilesEndpoint>();
  private listening?: PromiseWithResolvers<number>;
  private stopped?: PromiseWithResolvers<void>;
  private failure = Promise.withResolvers<Error>();

  /** Settles when a thread ends without being stopped, with why. */
  readonly failed: Promise<Error> = this.failure.promise;

  constructor(private options: FilesServerOptions) {}

  /** Make the credentials, start the threads, listen, and publish the endpoint to the client; the port actually listened on. */
  async start(): Promise<number> {
    // Made at each start and kept in memory only, so a restart leaves no credential behind that still works.
    const credentials: Pick<FilesEndpoint, 'secret' | 'tls'> = {};
    let auth: Auth;
    if (this.options.tls) {
      const tls = await makeTls();
      auth = { tls: { server: tls.server, client: tls.client.cert } };
      credentials.tls = { server: tls.server.cert, client: tls.client };
    } else {
      credentials.secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
      auth = { secret: credentials.secret };
    }
    const listener = new Worker(LISTEN_URL, { type: 'module' });
    this.listener = listener;
    this.listening = Promise.withResolvers();
    listener.onmessage = ({ data }: MessageEvent<FromListen>) => guarded(this.options.log, () => this.message(data));
    listener.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      guarded(this.options.log, () => this.fail(new Error(`ems-files listening thread: ${event.message}`)));
    };
    this.post({ op: 'start', port: this.options.port, sessions: SESSION_THREADS, auth });
    // The first session thread starts with the listener, so the first connection does not wait for one.
    this.more();
    const port = await this.listening.promise;
    this.credentials = credentials;
    this.publish([{ emsUrl: this.options.emsUrl, address: this.options.address }]);
    return port;
  }

  /**
   * Serve the requests to each of `targets`, each media service reaching this server at its own
   * address, and no longer those to a service this server published before and `targets` leaves out.
   */
  publish(targets: { emsUrl: string; address: string }[]): void {
    if (!this.credentials) return;
    const { endpoints } = filesState();
    const wanted = new Map(targets.map((target) => [target.emsUrl, target.address]));
    for (const [emsUrl, endpoint] of this.published) {
      if (wanted.get(emsUrl) === endpoint.address) continue;
      if (endpoints.get(emsUrl) === endpoint) endpoints.delete(emsUrl);
      this.published.delete(emsUrl);
    }
    for (const [emsUrl, address] of wanted) {
      if (this.published.has(emsUrl)) continue;
      const endpoint = { address, emsUrl, ...this.credentials };
      this.published.set(emsUrl, endpoint);
      endpoints.set(emsUrl, endpoint);
    }
  }

  async stop(): Promise<void> {
    if (!this.listener) return;
    this.unpublish();
    this.stopped = Promise.withResolvers();
    this.post({ op: 'stop' });
    await Promise.race([this.stopped.promise, this.failed]);
    // The sessions close their node handles through this thread while they stop.
    await Promise.race([Promise.all(this.sessions.map((session) => session.stop())), this.failed]);
    this.end();
  }

  private post(message: ToListen, transfer: Transferable[] = []): void {
    this.listener?.postMessage(message, transfer);
  }

  /** Start a session thread, and hand it to the listening thread once it serves. */
  private more(): void {
    if (!this.listener || this.sessions.length >= SESSION_THREADS) return;
    const { port1, port2 } = new MessageChannel();
    const session = new SessionThread(port1, this.options, (error) => this.fail(error));
    this.sessions.push(session);
    session.ready.then(() => this.post({ op: 'session', link: port2 }, [port2]), () => {});
  }

  private message(data: FromListen): void {
    switch (data.op) {
      case 'listening':
        return this.listening?.resolve(data.port);
      case 'failed':
        return this.fail(new Error(data.message));
      case 'more':
        return this.more();
      case 'log':
        return this.options.log?.(data.line);
      case 'stopped':
        return this.stopped?.resolve();
    }
  }

  private unpublish(): void {
    this.publish([]);
  }

  private end(): void {
    this.listener?.terminate();
    this.listener = undefined;
    for (const session of this.sessions) session.end();
    this.sessions = [];
  }

  private fail(error: Error): void {
    if (!this.listener) return;
    this.unpublish();
    this.end();
    this.listening?.reject(error);
    this.failure.resolve(error);
  }
}
