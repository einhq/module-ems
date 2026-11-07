/**
 * The thread `ems-files` listens on: it accepts the media service's connections, authenticates
 * each, and carries its bytes to a session thread (files-thread.ts), which serves them as SFTP. A
 * worker cannot be handed a socket, and without `--unstable-net` workers cannot share a port, so
 * the bytes go over a `MessagePort` per session thread, each connection's by its number on it
 * (`Link`).
 *
 * A connection is authenticated one of two ways (`Auth`):
 *
 * - plain: this side sends `EMS-Files <nonce>\n` (32 random bytes in hex), the client answers
 *   `HMAC-SHA256(secret, nonce)` in hex on a line, and the SFTP stream follows. Nothing is
 *   encrypted.
 * - TLS: TLS through node:tls (Deno's own TLS sockets cannot turn Nagle's algorithm off, which
 *   stalls every request on a delayed ACK, ein/core#1062), with this side's certificate and the
 *   one client certificate it accepts; the SFTP stream is all that is carried inside.
 *
 * A connection that has not authenticated within `HANDSHAKE_MS` is closed.
 *
 * A connection goes to a session thread with none, or, when every one has some, to a new one that
 * EiN's thread starts (`more`), until there are `sessions` of them; from then on to the one with
 * the fewest. Neither side lets more than `WINDOW` bytes of a connection wait on the other.
 *
 * On EiN's thread this file only says where it is: files-server.ts starts a worker by that URL.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import tls from 'node:tls';
import type { Pem } from './files-cert.ts';

export const LISTEN_URL = import.meta.url;

/** How many bytes of a connection, each way, may be on their way before the sender waits. */
export const WINDOW = 1024 * 1024;

const CHUNK = 64 * 1024;

const HANDSHAKE_MS = 10_000;

/** How a connection proves it is the media service's: the secret, or the client certificate. */
export type Auth = { secret: string } | { tls: { server: Pem; client: string } };

/** The messages between this thread and a session thread, about connection `id`. */
export type Link =
  /** A new connection, from the listening thread. */
  | { op: 'open'; id: number }
  /** Bytes the other side carries on: from the socket, or to it. */
  | { op: 'data'; id: number; data: Uint8Array }
  /** As many bytes as `n` have left the receiver's hands: read by SFTP, or written to the socket. */
  | { op: 'took'; id: number; n: number }
  /** The socket ended (from the listening thread), or the session ends the connection. */
  | { op: 'end'; id: number };

export type ToListen =
  | { op: 'start'; port: number; sessions: number; auth: Auth }
  | { op: 'session'; link: MessagePort }
  | { op: 'stop' };

export type FromListen =
  | { op: 'listening'; port: number }
  | { op: 'failed'; message: string }
  | { op: 'more' }
  | { op: 'log'; line: string }
  | { op: 'stopped' };

type Scope = {
  postMessage(message: FromListen): void;
  onmessage: ((event: MessageEvent<ToListen>) => void) | null;
};

/** An authenticated connection, as this thread reads and writes it: a socket, or TLS over one. */
type Wire = {
  read(into: Uint8Array): Promise<number | null>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
};

/** A session thread as this thread sees it: its port and how many connections it has. */
type Session = { link: MessagePort; open: number };

/** A connection being carried: its wire, its session, and its bytes not yet taken each way. */
type Carried = {
  wire: Wire;
  session: Session;
  /** Bytes from the socket the session has not read yet. */
  sent: number;
  room?: PromiseWithResolvers<void>;
  /** The socket's writes, in order. */
  writes: Promise<void>;
  ended: boolean;
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A socket as a wire, with `first` read before anything the socket brings. */
const socketWire = (conn: Deno.Conn, first: Uint8Array): Wire => {
  let pending = first;
  return {
    read: (into) => {
      if (pending.length === 0) return conn.read(into);
      const n = Math.min(into.length, pending.length);
      into.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return Promise.resolve(n);
    },
    write: async (data) => {
      for (let at = 0; at < data.length;) at += await conn.write(data.subarray(at));
    },
    close: () => {
      try {
        conn.close();
      } catch {
        // Closed already.
      }
    },
  };
};

/** A node:tls socket as a wire: what it brings waits in a queue, and it pauses while that holds `WINDOW`. */
const tlsWire = (socket: tls.TLSSocket): Wire => {
  const queue: Uint8Array[] = [];
  let queued = 0;
  let ended = false;
  let arrived: PromiseWithResolvers<void> | undefined;
  socket.on('data', (data: Uint8Array) => {
    queue.push(data);
    queued += data.length;
    if (queued >= WINDOW) socket.pause();
    arrived?.resolve();
  });
  const finish = () => {
    ended = true;
    arrived?.resolve();
  };
  socket.on('end', finish);
  socket.on('close', finish);
  socket.on('error', finish);
  return {
    read: async (into) => {
      while (queue.length === 0) {
        if (ended) return null;
        await (arrived = Promise.withResolvers()).promise;
      }
      const chunk = queue[0];
      const n = Math.min(into.length, chunk.length);
      into.set(chunk.subarray(0, n));
      if (n === chunk.length) queue.shift();
      else queue[0] = chunk.subarray(n);
      queued -= n;
      if (queued < WINDOW && socket.isPaused()) socket.resume();
      return n;
    },
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        if (ended) return reject(new Error('ems-files: the connection is closed'));
        socket.write(data, (error?: Error | null) => (error ? reject(error) : resolve()));
      }),
    close: () => {
      socket.end();
      socket.destroy();
    },
  };
};

/**
 * The plain handshake: the challenge out, the client's answer back. The wire to carry, with what
 * came after the answer, or undefined when the answer is wrong or late.
 */
const challenge = async (conn: Deno.Conn, secret: string): Promise<Wire | undefined> => {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  await conn.write(new TextEncoder().encode(`EMS-Files ${hex(nonce)}\n`));
  const want = new TextEncoder().encode(createHmac('sha256', secret).update(nonce).digest('hex'));
  let got = new Uint8Array(0);
  while (!got.includes(0x0a)) {
    if (got.length > 2 * want.length) return undefined;
    const buffer = new Uint8Array(4096);
    const n = await conn.read(buffer);
    if (n === null) return undefined;
    const joined = new Uint8Array(got.length + n);
    joined.set(got);
    joined.set(buffer.subarray(0, n), got.length);
    got = joined;
  }
  const newline = got.indexOf(0x0a);
  const answer = got.subarray(0, newline);
  if (answer.length !== want.length || !timingSafeEqual(answer, want)) return undefined;
  return socketWire(conn, got.slice(newline + 1));
};

/** Settles as `work` does, or with undefined after `ms`, calling `late` then. */
const within = <T>(ms: number, work: Promise<T>, late: () => void): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      late();
      resolve(undefined);
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

const listen = (scope: Scope): void => {
  const post = (message: FromListen) => scope.postMessage(message);
  const sessions: Session[] = [];
  const waiting: Wire[] = [];
  const carried = new Map<number, Carried>();
  let most = 1;
  let asked = false;
  let nextId = 1;
  let close: (() => void) | undefined;
  let stopped = false;

  const send = (session: Session, message: Link, transfer: Transferable[] = []) => session.link.postMessage(message, transfer);

  /** Where a connection goes; undefined when it waits for a session thread being started. */
  const choose = (): Session | undefined => {
    const idle = sessions.find((session) => session.open === 0);
    if (idle) return idle;
    if (sessions.length < most) {
      if (!asked) post({ op: 'more' });
      asked = true;
      return undefined;
    }
    return sessions.reduce((a, b) => (b.open < a.open ? b : a));
  };

  const place = (): void => {
    while (waiting.length > 0) {
      const session = choose();
      if (!session) return;
      carry(waiting.shift()!, session);
    }
  };

  const admit = (wire: Wire): void => {
    if (stopped) return wire.close();
    waiting.push(wire);
    place();
  };

  const end = (id: number): void => {
    const state = carried.get(id);
    if (!state || state.ended) return;
    state.ended = true;
    state.room?.resolve();
    void state.writes.finally(() => {
      state.wire.close();
      carried.delete(id);
      state.session.open--;
    });
  };

  const carry = (wire: Wire, session: Session): void => {
    const id = nextId++;
    const state: Carried = { wire, session, sent: 0, writes: Promise.resolve(), ended: false };
    carried.set(id, state);
    session.open++;
    send(session, { op: 'open', id });
    void (async () => {
      try {
        while (!state.ended) {
          while (state.sent >= WINDOW && !state.ended) await (state.room = Promise.withResolvers()).promise;
          if (state.ended) break;
          const buffer = new Uint8Array(CHUNK);
          const n = await wire.read(buffer);
          if (n === null) break;
          state.sent += n;
          send(session, { op: 'data', id, data: buffer.subarray(0, n) }, [buffer.buffer]);
        }
      } catch {
        // The socket closed under the read.
      }
      if (!state.ended) send(session, { op: 'end', id });
      end(id);
    })();
  };

  const linked = (link: MessagePort): void => {
    const session: Session = { link, open: 0 };
    link.onmessage = ({ data }: MessageEvent<Link>) => {
      const state = carried.get(data.id);
      if (!state) return;
      switch (data.op) {
        case 'data': {
          const { data: bytes } = data;
          state.writes = state.writes.then(async () => {
            if (state.ended) return;
            await state.wire.write(bytes);
            send(session, { op: 'took', id: data.id, n: bytes.length });
          }).catch(() => {
            send(session, { op: 'end', id: data.id });
            end(data.id);
          });
          return;
        }
        case 'took':
          state.sent -= data.n;
          if (state.sent < WINDOW) state.room?.resolve();
          return;
        case 'end':
          return end(data.id);
      }
    };
    sessions.push(session);
    asked = false;
    place();
  };

  /** Plain: accept on a socket, and admit each connection that answers the challenge. */
  const listenPlain = (port: number, secret: string): void => {
    const listener = Deno.listen({ port, hostname: '0.0.0.0' });
    close = () => listener.close();
    post({ op: 'listening', port: (listener.addr as Deno.NetAddr).port });
    void (async () => {
      try {
        for await (const conn of listener) {
          // Nagle's algorithm would hold each reply back until the client's delayed ACK.
          conn.setNoDelay(true);
          void within(HANDSHAKE_MS, challenge(conn, secret), () => conn.close())
            .catch(() => undefined)
            .then((wire) => {
              if (wire) admit(wire);
              else socketWire(conn, new Uint8Array(0)).close();
            });
        }
      } catch (error) {
        if (!stopped) post({ op: 'log', line: `ems-files: accepting: ${error instanceof Error ? error.message : error}` });
      }
    })();
  };

  /** TLS: node:tls checks the client's certificate during the handshake; a connection that completes it is admitted. */
  const listenTls = (port: number, auth: { server: Pem; client: string }): void => {
    const server = tls.createServer(
      { cert: auth.server.cert, key: auth.server.key, ca: [auth.client], requestCert: true, rejectUnauthorized: true, handshakeTimeout: HANDSHAKE_MS },
      (socket) => {
        socket.setNoDelay(true);
        admit(tlsWire(socket));
      },
    );
    // Deno's node:tls reports a refused certificate or a handshake past its timeout without closing the socket.
    server.on('tlsClientError', (_error: Error, socket?: tls.TLSSocket) => socket?.destroy());
    server.on('error', (error: Error) => {
      if (stopped) return;
      if (close) post({ op: 'log', line: `ems-files: ${error.message}` });
      else post({ op: 'failed', message: error.message });
    });
    server.listen(port, '0.0.0.0', () => {
      close = () => server.close();
      post({ op: 'listening', port: (server.address() as { port: number }).port });
    });
  };

  scope.onmessage = ({ data }) => {
    switch (data.op) {
      case 'start':
        most = Math.max(1, data.sessions);
        try {
          if ('tls' in data.auth) listenTls(data.port, data.auth.tls);
          else listenPlain(data.port, data.auth.secret);
        } catch (error) {
          post({ op: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
        return;
      case 'session':
        return linked(data.link);
      case 'stop': {
        stopped = true;
        close?.();
        for (const wire of waiting.splice(0)) wire.close();
        for (const id of [...carried.keys()]) end(id);
        return post({ op: 'stopped' });
      }
    }
  };
};

if ('WorkerGlobalScope' in globalThis) listen(self as unknown as Scope);
