/**
 * The GPU probe.
 *
 * The card is EMS's, so the only source is EMS's health,
 * and the shape it answers in is EMS's, not ours. These pin the translation and
 * the two ways it goes absent — no EMS, and an EMS that cannot see a card —
 * which the dashboard must render as "no GPU", never as an idle one.
 */

import { assertEquals } from '@std/assert';
import type { SettingsContext } from '@ein/client';
import { gpuSampleFromHealth, sampleGpu } from '../lib/gpu.ts';

/** A command at `url` on a system whose settings files are `files`, by path; any other read fails. */
const commandAt = (url: string | undefined, files: Record<string, string> = {}): SettingsContext =>
  ({
    env: url === undefined ? {} : { CFG_EMS_URL: url },
    sys: {
      vfs: {
        open: (_access: unknown, path: string) =>
          path in files
            ? Promise.resolve({ readable: ReadableStream.from([new TextEncoder().encode(files[path])]), close: () => Promise.resolve() })
            : Promise.reject(new Error(`${path}: no such node`)),
        children: () => Promise.reject(new Error('no such node')),
      },
    },
  }) as unknown as SettingsContext;

const HEALTH = {
  ok: true,
  api: '2.0.0',
  gpu: { present: true, vram_allocated_mb: 6100, vram_reserved_mb: 7900, util_pct: 37, mem_used_mb: 8123, mem_total_mb: 16311, temp_c: 51 },
};

Deno.test('gpuSampleFromHealth: EMS field names become the series entry', () => {
  assertEquals(gpuSampleFromHealth(HEALTH), { utilPct: 37, memUsedMb: 8123, memTotalMb: 16311, tempC: 51 });
});

Deno.test('gpuSampleFromHealth: a card EMS cannot read is no sample', () => {
  // `present` alone — torch's view or no view — says nothing about utilization.
  assertEquals(gpuSampleFromHealth({ ok: true, gpu: { present: true, vram_reserved_mb: 7900 } }), undefined);
  assertEquals(gpuSampleFromHealth({ ok: true, gpu: { present: false } }), undefined);
  assertEquals(gpuSampleFromHealth({ ok: true }), undefined);
  assertEquals(gpuSampleFromHealth(null), undefined);
  assertEquals(gpuSampleFromHealth({ gpu: { util_pct: '37', mem_used_mb: 1, mem_total_mb: 2, temp_c: 3 } }), undefined);
});

Deno.test("sampleGpu: asks /v0/health, with the key when it is the system's EMS, and reads the card", async () => {
  const seen: { path: string; authorization: string | null }[] = [];
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, (request) => {
    seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization') });
    return Response.json(HEALTH);
  });
  try {
    const url = `http://127.0.0.1:${server.addr.port}/`;
    const files = { '/etc/environment': `export CFG_EMS_URL='${url}'\n`, '/etc/keys': "export CFG_EMS_KEY='let-me-in'\n" };
    assertEquals(await sampleGpu(commandAt(url, files)), { utilPct: 37, memUsedMb: 8123, memTotalMb: 16311, tempC: 51 });
    // The same EMS under another address than the system's is not given the key.
    assertEquals(await sampleGpu(commandAt(url.replace(/\/$/, ''), files)), { utilPct: 37, memUsedMb: 8123, memTotalMb: 16311, tempC: 51 });
    assertEquals(seen, [{ path: '/v0/health', authorization: 'Bearer let-me-in' }, { path: '/v0/health', authorization: null }]);
  } finally {
    await server.shutdown();
  }
});

Deno.test('sampleGpu: no address, no EMS, or a refusal is no sample', async () => {
  assertEquals(await sampleGpu(commandAt(undefined)), undefined);
  assertEquals(await sampleGpu(commandAt('http://127.0.0.1:1')), undefined);

  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, () => Response.json({ ok: false }, { status: 401 }));
  try {
    assertEquals(await sampleGpu(commandAt(`http://127.0.0.1:${server.addr.port}`)), undefined);
  } finally {
    await server.shutdown();
  }
});
