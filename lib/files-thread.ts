/**
 * A thread `ems-files` serves on: an SSH server and its sessions for the connections the listening
 * thread (files-listen.ts) hands it, with a copy of the names of the requests in flight, so that
 * no SFTP request waits on EiN's own event loop or on another connection's. Only a name that
 * stands for a node with no file on disk goes back to EiN's thread, each call on its handle a
 * message there and back (`NodeCall`).
 *
 * On EiN's thread this file only says where it is: files-server.ts starts workers by that URL,
 * which is the staged copy a `#!ts` bin was loaded with.
 */

import type { adapters } from 'ssh2';
import { type Link, WINDOW } from './files-listen.ts';
import { FilesSshServer } from './files-ssh.ts';
import type { NodeAccess, NodeHandle } from './files-sftp.ts';
import { changeNames, type Named, type NamesChange } from './files.ts';

export const THREAD_URL = import.meta.url;

/** A call on the VFS, which EiN's thread makes; a handle is the number its open answered. */
export type NodeCall =
  | { call: 'open'; path: string; mode: Named['mode'] }
  | { call: 'stat'; path: string }
  | { call: 'seek'; handle: number; offset: number }
  | { call: 'read'; handle: number; size: number }
  | { call: 'write'; handle: number; data: Uint8Array }
  | { call: 'size' | 'close'; handle: number };

/** A failed call's error, by its class's name, so that `Deno.errors.NotFound` stays one. */
type CallError = { name: string; message: string };

export type ToThread =
  | { op: 'start'; hostKey: string; clientKey: string; names: NamesChange; link: MessagePort }
  | { op: 'names'; seq: number; change: NamesChange }
  | { op: 'answer'; id: number; value?: unknown; error?: CallError }
  | { op: 'stop' };

export type FromThread =
  | { op: 'started' }
  | { op: 'failed'; message: string }
  | { op: 'names'; seq: number }
  | ({ op: 'node'; id: number } & NodeCall)
  | { op: 'log'; line: string }
  | { op: 'stopped' };

type Scope = {
  postMessage(message: FromThread, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToThread>) => void) | null;
};

const errorOf = ({ name, message }: CallError): Error => {
  const Kind = (Deno.errors as unknown as Record<string, ErrorConstructor | undefined>)[name];
  return Kind ? new Kind(message) : new Error(message);
};

/**
 * One connection as SSH reads and writes it, its bytes carried by the listening thread. A write
 * waits while `WINDOW` bytes or more of it are not yet on the socket.
 */
class LinkTransport implements adapters.Transport {
  closed = false;
  readonly writable: WritableStream<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private ended = false;
  private arrived?: PromiseWithResolvers<void>;
  private taken = 0;
  private unwritten = 0;
  private room?: PromiseWithResolvers<void>;
  private stream?: ReadableStream<Uint8Array>;

  constructor(
    private id: number,
    private send: (message: Link, transfer?: Transferable[]) => void,
    private done: () => void,
    readonly remoteAddress?: string,
    readonly remotePort?: number,
  ) {
    this.writable = new WritableStream({
      write: async (chunk) => {
        if (this.closed) throw new Error('ems-files: the connection is closed');
        // A copy of the chunk's bytes alone: SSH may reuse its buffer, and the copy is handed over.
        const data = chunk.slice();
        this.unwritten += data.length;
        this.send({ op: 'data', id, data }, [data.buffer]);
        while (this.unwritten >= WINDOW && !this.closed) await (this.room = Promise.withResolvers()).promise;
      },
      close: () => this.close(),
      abort: () => this.close(),
    });
  }

  get readable(): ReadableStream<Uint8Array> {
    return this.stream ??= new ReadableStream({
      pull: async (controller) => {
        const buffer = new Uint8Array(64 * 1024);
        const n = await this.read(buffer);
        if (n === null) controller.close();
        else controller.enqueue(buffer.subarray(0, n));
      },
    });
  }

  async read(buffer: Uint8Array): Promise<number | null> {
    while (this.chunks.length === 0) {
      if (this.ended || this.closed) return null;
      await (this.arrived = Promise.withResolvers()).promise;
    }
    const chunk = this.chunks[0];
    const n = Math.min(buffer.length, chunk.length);
    buffer.set(chunk.subarray(0, n));
    if (n === chunk.length) this.chunks.shift();
    else this.chunks[0] = chunk.subarray(n);
    // Taken bytes are told in batches, well before the listening thread would wait for them.
    this.taken += n;
    if (this.taken >= WINDOW / 4) {
      this.send({ op: 'took', id: this.id, n: this.taken });
      this.taken = 0;
    }
    return n;
  }

  /** What the listening thread says of this connection. */
  take(message: Link): void {
    switch (message.op) {
      case 'data':
        this.chunks.push(message.data);
        return this.arrived?.resolve();
      case 'took':
        this.unwritten -= message.n;
        if (this.unwritten < WINDOW) this.room?.resolve();
        return;
      case 'end':
        this.ended = true;
        this.arrived?.resolve();
        return this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.ended) this.send({ op: 'end', id: this.id });
    this.arrived?.resolve();
    this.room?.resolve();
    this.done();
  }
}

const serve = (scope: Scope): void => {
  const post = (message: FromThread, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
  const log = (line: string) => post({ op: 'log', line });
  const waiting = new Map<number, PromiseWithResolvers<unknown>>();
  let nextCall = 1;
  const ask = <T>(call: NodeCall): Promise<T> => {
    const id = nextCall++;
    const answer = Promise.withResolvers<unknown>();
    waiting.set(id, answer);
    // A copy of a write's bytes alone: the data may be a view of a larger buffer.
    if (call.call === 'write') {
      const data = call.data.slice();
      post({ op: 'node', id, ...call, data }, [data.buffer]);
    } else {
      post({ op: 'node', id, ...call });
    }
    return answer.promise as Promise<T>;
  };
  const handleOf = (handle: number): NodeHandle => ({
    seek: (offset) => ask({ call: 'seek', handle, offset }),
    read: (size) => ask({ call: 'read', handle, size }),
    write: (data) => ask({ call: 'write', handle, data }),
    size: () => ask({ call: 'size', handle }),
    close: () => ask({ call: 'close', handle }),
  });
  const nodes: NodeAccess = {
    open: async (path, mode) => handleOf(await ask<number>({ call: 'open', path, mode })),
    stat: (path) => ask({ call: 'stat', path }),
  };

  let server: FilesSshServer | undefined;
  const transports = new Map<number, LinkTransport>();
  const linked = (link: MessagePort): void => {
    const send = (message: Link, transfer: Transferable[] = []) => link.postMessage(message, transfer);
    link.onmessage = ({ data }: MessageEvent<Link>) => {
      if (data.op === 'open') {
        const transport = new LinkTransport(data.id, send, () => transports.delete(data.id), data.remoteAddress, data.remotePort);
        transports.set(data.id, transport);
        void server?.serve(transport).catch((error) => log(`ems-files: a connection: ${error instanceof Error ? error.message : error}`));
        return;
      }
      transports.get(data.id)?.take(data);
    };
  };

  scope.onmessage = async ({ data }) => {
    switch (data.op) {
      case 'start':
        await changeNames(data.names);
        try {
          server = new FilesSshServer({ hostKey: data.hostKey, clientKey: data.clientKey, nodes, log });
        } catch (error) {
          return post({ op: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
        linked(data.link);
        return post({ op: 'started' });
      case 'names':
        await changeNames(data.change);
        return post({ op: 'names', seq: data.seq });
      case 'answer': {
        const answer = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.error) answer?.reject(errorOf(data.error));
        else answer?.resolve(data.value);
        return;
      }
      case 'stop':
        await server?.stop();
        return post({ op: 'stopped' });
    }
  };
};

if ('WorkerGlobalScope' in globalThis) serve(self as unknown as Scope);
