/**
 * A stand-in EMS on loopback for the fast tier: answers each op from a table, records what it
 * was asked, and speaks the real envelope (`{ok, result, meta}` / `{ok:false, error}`), so a
 * caller's handling of both is what gets exercised — never a model.
 */

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
  close: () => Promise<void>;
};

export type StubOptions = {
  /** `op` → reply, e.g. `{ 'text.embed': { result: { embedding: [1], dimension: 1 } } }`. */
  ops?: Record<string, StubReply>;
  health?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown>;
  /** Delay every answer, for timeout tests. */
  delayMs?: number;
  /** SSE progress phases to send before the terminal answer, by operation. */
  progress?: Record<string, string[]>;
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

export const startStubEms = (options: StubOptions = {}): StubEms => {
  const requests: StubEms['requests'] = [];
  const hungUp: string[] = [];
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v0\//, '');
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
        roots: [],
        tools: {},
        models: {},
        limits: {},
        signatures: {},
        ...(options.capabilities ?? {}),
      });
    }
    const op = path.replace('/', '.');
    const body = req.method === 'POST' ? await req.json() as Record<string, unknown> : {};
    requests.push({ op, body, authorization: req.headers.get('authorization') });
    await delay(op);
    const reply = options.ops?.[op];
    if (reply === undefined) {
      return Response.json({ ok: false, error: { code: 'invalid_request', message: `unknown op: ${op}`, permanent: true } }, { status: 400 });
    }
    const resolved = typeof reply === 'function' ? await reply(body) : reply;
    const { status, body: answer } = envelope(resolved);
    if (req.headers.get('accept')?.includes('text/event-stream')) {
      const events = (options.progress?.[op] ?? []).map((phase) => `event: progress\ndata: ${JSON.stringify({ phase })}\n\n`);
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
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    hungUp,
    close: () => server.shutdown(),
  };
};
