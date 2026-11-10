/**
 * A stand-in EMS on loopback for the fast tier: answers each op from a table, records what it
 * was asked, and speaks the real envelope (`{ok, result, meta}` / `{ok:false, error}`), so a
 * caller's handling of both is what gets exercised — never a model. Its watches are kept as they
 * are put, and a test tells their events (`tell`).
 *
 * It serves itself the files of its requests as `ems-files` serves EMS, in the same process: the
 * client sends names, and what the stub records and hands its handlers is the file each stands
 * for, a disk path or the VFS path of a node with none.
 */

import { filesState, lookup } from '../lib/files.ts';
import { FilesServer } from '../lib/files-server.ts';

export type StubAnswer =
  | { result: unknown; producer?: string; meta?: Record<string, unknown> }
  | { error: { code: string; message: string; permanent?: boolean }; status?: number };

export type StubReply = StubAnswer | ((body: Record<string, unknown>) => StubAnswer | Promise<StubAnswer>);

export type StubEms = {
  url: string;
  /** Every request, as `{ op, body, authorization }`, in order. */
  requests: { op: string; body: Record<string, unknown>; authorization: string | null }[];
  /** Ops whose caller closed the connection before they were answered, in order. */
  hungUp: string[];
  /** The watches put, by id, each with the spec it was given. */
  watches: Map<string, Record<string, unknown>>;
  /** Send an event to whoever follows the watch `id`'s events; answers how many do. */
  tell: (id: string, event: Record<string, unknown>) => number;
  close: () => Promise<void>;
};

export type StubOptions = {
  /** `op` → reply, e.g. `{ 'text.embed': { result: { embedding: [1], dimension: 1 } } }`. */
  ops?: Record<string, StubReply>;
  health?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown>;
  /** Delay every answer, for timeout tests. */
  delayMs?: number;
  /** SSE progress events to send before the terminal answer, by operation: a phase, or a phase and how much is done. */
  progress?: Record<string, (string | { phase: string; fraction: number })[]>;
  /** Pause before each SSE event, for callers that need to observe intermediate phases. */
  progressDelayMs?: number;
};

const envelope = (reply: StubAnswer): { status: number; body: Record<string, unknown> } => {
  if ('error' in reply) {
    return { status: reply.status ?? 500, body: { ok: false, error: reply.error } };
  }
  return {
    status: 200,
    body: { ok: true, result: reply.result, meta: { took_ms: 1, api: '0.1.0', ...(reply.producer ? { producer: reply.producer } : {}), ...reply.meta } },
  };
};

/**
 * A body with each of its names back as the file it stands for (`Named`): the disk path, or the VFS
 * path of a node with none, which is what a test's stub reads and writes in EMS's place.
 */
const unnamed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(unnamed);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const ref = child as Record<string, unknown>;
    const named = (key === 'file' || key === 'output') && ref && typeof ref.path === 'string' ? lookup(ref.path) : undefined;
    out[key] = named && named !== 'directory' ? { ...ref, path: named.disk ?? named.node } : unnamed(child);
  }
  return out;
};

/** A watch's status as the stub answers it. */
const watchStatus = (id: string, spec: Record<string, unknown>) => ({
  id,
  source: String(spec.source ?? ''),
  state: 'running',
  since: new Date(0).toISOString(),
  frames: 0,
  looked: 0,
  faces: 0,
  following: 0,
  motion: false,
});

export const startStubEms = (options: StubOptions = {}): StubEms => {
  const requests: StubEms['requests'] = [];
  const hungUp: string[] = [];
  const watches = new Map<string, Record<string, unknown>>();
  const followers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ok = (result: unknown) => Response.json({ ok: true, result, meta: { api: '0.3.5' } });
  const watchRoute = async (req: Request, path: string): Promise<Response> => {
    const [, id, events] = path.split('/').map(decodeURIComponent);
    if (!id && req.method === 'GET') return ok([...watches].map(([each, spec]) => watchStatus(each, spec)));
    if (id && events === 'events' && req.method === 'GET') {
      if (!watches.has(id)) return Response.json({ ok: false, error: { code: 'not_found', message: `no watch ${id}` } }, { status: 404 });
      let follower: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          follower = controller;
          if (!followers.has(id)) followers.set(id, new Set());
          followers.get(id)!.add(controller);
          controller.enqueue(sse('state', watchStatus(id, watches.get(id)!)));
        },
        cancel() {
          followers.get(id)?.delete(follower);
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (id && req.method === 'PUT') {
      const spec = await req.json() as Record<string, unknown>;
      const made = JSON.stringify(watches.get(id)) !== JSON.stringify(spec);
      watches.set(id, spec);
      return ok({ ...watchStatus(id, spec), made });
    }
    if (id && req.method === 'DELETE') {
      watches.delete(id);
      for (const follower of followers.get(id) ?? []) {
        follower.enqueue(sse('end', { watch: id }));
        follower.close();
      }
      followers.delete(id);
      return ok(null);
    }
    return Response.json({ ok: false, error: { code: 'invalid_request', message: `no route ${req.method} ${path}` } }, { status: 400 });
  };
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v0\//, '');
    if (path === 'watches' || path.startsWith('watches/')) return await watchRoute(req, path);
    // The signal also fires once an answer is sent, so only an abort during the delay is a hang-up.
    const delay = async (op: string) => {
      if (!options.delayMs) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          req.signal.removeEventListener('abort', hangUp);
          resolve();
        }, options.delayMs);
        const hangUp = () => {
          clearTimeout(timer);
          hungUp.push(op);
          resolve();
        };
        req.signal.addEventListener('abort', hangUp, { once: true });
      });
    };
    if (req.method === 'GET') await delay(path);
    if (req.method === 'GET' && path === 'health') {
      if (options.health === null) return new Response('down', { status: 503 });
      return Response.json({ ok: true, api: '3.0.0', uptime: 1, gpu: { present: false }, models: {}, worker: { running: true, restarts: 0 }, ...(options.health ?? {}) });
    }
    if (req.method === 'GET' && path === 'capabilities') {
      return Response.json({
        api: '3.0.0',
        ops: Object.keys(options.ops ?? {}),
        tools: {},
        models: {},
        limits: {},
        signatures: {},
        ...(options.capabilities ?? {}),
      });
    }
    const op = path.replace('/', '.');
    const body = req.method === 'POST' ? unnamed(await req.json()) as Record<string, unknown> : {};
    requests.push({ op, body, authorization: req.headers.get('authorization') });
    await delay(op);
    const reply = options.ops?.[op];
    if (reply === undefined) {
      return Response.json({ ok: false, error: { code: 'invalid_request', message: `unknown op: ${op}`, permanent: true } }, { status: 400 });
    }
    const resolved = typeof reply === 'function' ? await reply(body) : reply;
    const { status, body: answer } = envelope(resolved);
    if (req.headers.get('accept')?.includes('text/event-stream')) {
      const events = (options.progress?.[op] ?? []).map((event) => `event: progress\ndata: ${JSON.stringify(typeof event === 'string' ? { phase: event } : event)}\n\n`);
      events.push(`event: ${'error' in resolved ? 'error' : 'result'}\ndata: ${JSON.stringify(answer)}\n\n`);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (const event of events) {
            if (options.progressDelayMs) await new Promise((resolve) => setTimeout(resolve, options.progressDelayMs));
            controller.enqueue(encoder.encode(event));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json(answer, { status });
  });
  const addr = server.addr as Deno.NetAddr;
  const url = `http://127.0.0.1:${addr.port}`;
  filesState().endpoints.set(url, { address: 'stub-ems:0', emsUrl: url, secret: 'stub' });
  return {
    url,
    requests,
    hungUp,
    watches,
    tell: (id, event) => {
      const each = followers.get(id) ?? new Set();
      for (const follower of each) follower.enqueue(sse(String(event.type), { watch: id, at: new Date().toISOString(), t: 0, ...event }));
      return each.size;
    },
    close: () => {
      for (const each of followers.values()) for (const follower of each) follower.close();
      filesState().endpoints.delete(url);
      return server.shutdown();
    },
  };
};

/**
 * An `ems-files` endpoint for a real EMS at `emsUrl`, for a test that calls it without booting EiN:
 * it serves the files on this host's disk that a request names, reached at `address`
 * (`CFG_EMS_FILES_ADDRESS`, as EMS sees it) and listening on `port`. An endpoint already serving
 * `emsUrl` in this process — a booted system's own — is kept, and `stop` leaves it.
 */
export const serveEmsFiles = async (emsUrl: string, address: string, port: number): Promise<{ stop: () => Promise<void> }> => {
  if (filesState().endpoints.has(emsUrl)) return { stop: () => Promise.resolve() };
  const noNodes = () => Promise.reject(new Error('no VFS here: only files on disk'));
  const server = new FilesServer({ port, address, emsUrl, nodes: { open: noNodes, stat: noNodes } });
  await server.start();
  return { stop: () => server.stop() };
};
