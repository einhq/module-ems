/**
 * A thread `ems-files` serves on: an SFTP session for each connection the listening thread
 * (files-listen.ts) hands it, authenticated already, with a copy of the names of the requests in
 * flight, so that no SFTP request waits on EiN's own event loop or on another connection's. Only a name that
 * stands for a node with no file on disk goes back to EiN's thread, each call on its handle a
 * message there and back (`NodeCall`).
 *
 * On EiN's thread this file only says where it is: files-server.ts starts workers by that URL,
 * which is the staged copy a `#!ts` bin was loaded with.
 */

import { SFTP } from 'ssh2';
import { type Link, WINDOW } from './files-listen.ts';
import { FilesSession, type NodeAccess, type NodeHandle } from './files-sftp.ts';
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
  | { op: 'start'; names: NamesChange; link: MessagePort }
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
 * One connection's SFTP session, its bytes carried by the listening thread: what arrives is pushed
 * into the session as it is (each a buffer handed over, which nothing else holds), and what the
 * session answers in one turn goes back as one message. Answers wait while `WINDOW` bytes or more
 * of them are not yet on the socket.
 */
class LinkSession {
  private ended = false;
  private sftp: SFTP;
  private files: FilesSession;
  private pending: Uint8Array[] = [];
  private flushing = false;
  private taken = 0;
  private unwritten = 0;
  private room?: PromiseWithResolvers<void>;

  constructor(
    private id: number,
    private send: (message: Link, transfer?: Transferable[]) => void,
    nodes: NodeAccess,
    log: (line: string) => void,
    private done: () => void,
  ) {
    const queue = (parts: readonly Uint8Array[]) => {
      this.pending.push(...parts);
      if (!this.flushing) queueMicrotask(() => void this.flush());
    };
    // The session is the channel's only user and nothing limits it but `WINDOW`, so it never waits for a window.
    const endpoint = { id: 0, window: Number.MAX_SAFE_INTEGER, packetSize: Number.MAX_SAFE_INTEGER, state: 'open' };
    this.sftp = new SFTP(
      { protocol: { channelData: (_id, data) => queue([data]), channelDataParts: (_id, parts) => queue(parts), channelClose: () => void this.end() } },
      { type: 'session', incoming: { ...endpoint }, outgoing: { ...endpoint } },
      { server: true },
    );
    this.files = new FilesSession(nodes, log);
    this.files.attach(this.sftp);
  }

  /** What the listening thread says of this connection. */
  take(message: Link): void {
    switch (message.op) {
      case 'data':
        if (this.ended) return;
        this.sftp.push(message.data);
        // Taken bytes are told in batches, well before the listening thread would wait for them.
        this.taken += message.data.length;
        if (this.taken >= WINDOW / 4) {
          this.send({ op: 'took', id: this.id, n: this.taken });
          this.taken = 0;
        }
        return;
      case 'took':
        this.unwritten -= message.n;
        if (this.unwritten < WINDOW) this.room?.resolve();
        return;
      case 'end':
        return void this.end(false);
    }
  }

  /** The session's answers so far, copied into one buffer each round and handed over. */
  private async flush(): Promise<void> {
    this.flushing = true;
    while (this.pending.length > 0 && !this.ended) {
      const parts = this.pending;
      this.pending = [];
      const data = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
      let at = 0;
      for (const part of parts) {
        data.set(part, at);
        at += part.length;
      }
      this.unwritten += data.length;
      this.send({ op: 'data', id: this.id, data }, [data.buffer]);
      while (this.unwritten >= WINDOW && !this.ended) await (this.room = Promise.withResolvers()).promise;
    }
    this.flushing = false;
  }

  /** End the session, and the connection unless it ended first; settles once its files are closed. */
  end(tell = true): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.ended = true;
    if (tell) this.send({ op: 'end', id: this.id });
    this.room?.resolve();
    this.sftp.push(null);
    this.done();
    return this.files.closeAll();
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

  const sessions = new Map<number, LinkSession>();
  const linked = (link: MessagePort): void => {
    const send = (message: Link, transfer: Transferable[] = []) => link.postMessage(message, transfer);
    link.onmessage = ({ data }: MessageEvent<Link>) => {
      if (data.op === 'open') {
        sessions.set(data.id, new LinkSession(data.id, send, nodes, log, () => sessions.delete(data.id)));
        return;
      }
      sessions.get(data.id)?.take(data);
    };
  };

  scope.onmessage = async ({ data }) => {
    switch (data.op) {
      case 'start':
        await changeNames(data.names);
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
        // The sessions close their node handles through EiN's thread while they stop.
        await Promise.all([...sessions.values()].map((session) => session.end()));
        return post({ op: 'stopped' });
    }
  };
};

if ('WorkerGlobalScope' in globalThis) serve(self as unknown as Scope);
