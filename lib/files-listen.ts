/**
 * The thread `ems-files` listens on: it accepts the media service's connections and carries each
 * one's bytes to a session thread (files-thread.ts), which serves it. A worker cannot be handed a
 * socket, and without `--unstable-net` workers cannot share a port, so the bytes go over a
 * `MessagePort` per session thread, each connection's by its number on it (`Link`).
 *
 * A connection goes to a session thread with none, or, when every one has some, to a new one that
 * EiN's thread starts (`more`), until there are `sessions` of them; from then on to the one with
 * the fewest. Neither side lets more than `WINDOW` bytes of a connection wait on the other.
 *
 * On EiN's thread this file only says where it is: files-server.ts starts a worker by that URL.
 */

export const LISTEN_URL = import.meta.url;

/** How many bytes of a connection, each way, may be on their way before the sender waits. */
export const WINDOW = 1024 * 1024;

const CHUNK = 64 * 1024;

/** The messages between this thread and a session thread, about connection `id`. */
export type Link =
  /** A new connection, from the listening thread. */
  | { op: 'open'; id: number; remoteAddress?: string; remotePort?: number }
  /** Bytes the other side carries on: from the socket, or to it. */
  | { op: 'data'; id: number; data: Uint8Array }
  /** As many bytes as `n` have left the receiver's hands: read by SSH, or written to the socket. */
  | { op: 'took'; id: number; n: number }
  /** The socket ended (from the listening thread), or the session ends the connection. */
  | { op: 'end'; id: number };

export type ToListen =
  | { op: 'start'; port: number; sessions: number }
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

/** A session thread as this thread sees it: its port and how many connections it has. */
type Session = { link: MessagePort; open: number };

/** A connection being carried: its socket, its session, and its bytes not yet taken each way. */
type Carried = {
  conn: Deno.Conn;
  session: Session;
  /** Bytes from the socket the session has not read yet. */
  sent: number;
  room?: PromiseWithResolvers<void>;
  /** The socket's writes, in order. */
  writes: Promise<void>;
  ended: boolean;
};

const listen = (scope: Scope): void => {
  const post = (message: FromListen) => scope.postMessage(message);
  const sessions: Session[] = [];
  const waiting: Deno.Conn[] = [];
  const carried = new Map<number, Carried>();
  let most = 1;
  let asked = false;
  let nextId = 1;
  let listener: Deno.Listener | undefined;

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

  const end = (id: number): void => {
    const conn = carried.get(id);
    if (!conn || conn.ended) return;
    conn.ended = true;
    conn.room?.resolve();
    void conn.writes.finally(() => {
      try {
        conn.conn.close();
      } catch {
        // Closed already.
      }
      carried.delete(id);
      conn.session.open--;
    });
  };

  const carry = (conn: Deno.Conn, session: Session): void => {
    const id = nextId++;
    const state: Carried = { conn, session, sent: 0, writes: Promise.resolve(), ended: false };
    carried.set(id, state);
    session.open++;
    (conn as Deno.TcpConn).setNoDelay?.(true);
    const remote = conn.remoteAddr as Deno.NetAddr;
    send(session, { op: 'open', id, remoteAddress: remote.hostname, remotePort: remote.port });
    void (async () => {
      try {
        while (!state.ended) {
          while (state.sent >= WINDOW && !state.ended) await (state.room = Promise.withResolvers()).promise;
          if (state.ended) break;
          const buffer = new Uint8Array(CHUNK);
          const n = await conn.read(buffer);
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
            for (let at = 0; at < bytes.length;) at += await state.conn.write(bytes.subarray(at));
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

  const accept = async (on: Deno.Listener): Promise<void> => {
    try {
      for await (const conn of on) {
        waiting.push(conn);
        place();
      }
    } catch (error) {
      if (listener) post({ op: 'log', line: `ems-files: accepting: ${error instanceof Error ? error.message : error}` });
    }
  };

  scope.onmessage = ({ data }) => {
    switch (data.op) {
      case 'start':
        most = Math.max(1, data.sessions);
        try {
          listener = Deno.listen({ port: data.port, hostname: '0.0.0.0' });
        } catch (error) {
          return post({ op: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
        post({ op: 'listening', port: (listener.addr as Deno.NetAddr).port });
        void accept(listener);
        return;
      case 'session':
        return linked(data.link);
      case 'stop': {
        const on = listener;
        listener = undefined;
        on?.close();
        for (const conn of waiting.splice(0)) conn.close();
        for (const id of [...carried.keys()]) end(id);
        return post({ op: 'stopped' });
      }
    }
  };
};

if ('WorkerGlobalScope' in globalThis) listen(self as unknown as Scope);
