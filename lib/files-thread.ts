/**
 * The thread `ems-files` serves on: the SSH server and its sessions, with a copy of the names of
 * the requests in flight, so that no SFTP request waits on EiN's own event loop. Only a name that
 * stands for a node with no file on disk goes back to EiN's thread, each call on its handle a
 * message there and back (`NodeCall`).
 *
 * On EiN's thread this file only says where it is: files-server.ts starts a worker by that URL,
 * which is the staged copy a `#!ts` bin was loaded with.
 */

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
  | { op: 'start'; port: number; names: NamesChange }
  | { op: 'names'; seq: number; change: NamesChange }
  | { op: 'answer'; id: number; value?: unknown; error?: CallError }
  | { op: 'stop' };

export type FromThread =
  | { op: 'listening'; port: number; secret: string; hostKey: string }
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

const serve = (scope: Scope): void => {
  const post = (message: FromThread, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
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
  scope.onmessage = async ({ data }) => {
    switch (data.op) {
      case 'start':
        await changeNames(data.names);
        server = new FilesSshServer({ port: data.port, nodes, log: (line) => post({ op: 'log', line }) });
        try {
          post({ op: 'listening', ...await server.start() });
        } catch (error) {
          post({ op: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
        return;
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
