/**
 * The media service's instances. The primary, `main`, is the media service settings
 * (`CFG_EMS_URL`, `CFG_EMS_KEY`, `CFG_EMS_FILES_ADDRESS`); every other one is a node of its own,
 * `/etc/ems.d/<name>`, which `ems-instance` writes: its address, its key, where it reaches EiN's
 * files, and the slots EiN keeps in flight against it. The node is the administrator's alone, since
 * it holds the key, and is read as the administrator: the key goes only to the address beside it.
 *
 * A command calls the instance `CFG_EMS_INSTANCE` names, which a pool worker for that instance sets
 * on its steps (`pipeline-worker --env`), or the primary when it names none. What EMS stamps its
 * results with is the primary's: a second instance takes a kind of work only when it stamps that
 * work the same (`sameGenerations`), so two models' vectors never mix.
 */

import { ADMIN_ACCESS, type Command, serviceKey } from '@ein/client';
import type { EmsCapabilities } from './api.ts';

/** The primary's name. */
export const PRIMARY = 'main';

/** Where the other instances' nodes are. */
export const INSTANCES_DIR = '/etc/ems.d';

const DEFAULT_URL = 'http://127.0.0.1:8181';

/** A name an instance may have: lower case, digits and dashes, as a host name. */
export const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** One instance's node, as it is stored. */
export type InstanceNode = {
  url: string;
  key?: string;
  /** `host:port` of `ems-files` as this instance reaches it; the primary's when unset. */
  filesAddress?: string;
  /** Model requests EiN keeps in flight against it; its `capabilities.limits.models` when unset. */
  modelSlots?: number;
  /** Tool requests EiN keeps in flight against it; its `capabilities.limits.tools` when unset. */
  cpuSlots?: number;
};

export type EmsInstance = InstanceNode & { name: string; primary: boolean };

type Reader = Pick<Command, 'sys' | 'env'>;

const readNode = async (cmd: Reader, name: string): Promise<InstanceNode | undefined> => {
  try {
    const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, `${INSTANCES_DIR}/${name}`, { mode: 'r' });
    try {
      const node = JSON.parse(await new Response(handle.readable).text()) as InstanceNode;
      return node && typeof node.url === 'string' && node.url ? node : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

/** The primary, from the settings; its key only when the address is the system's own (`serviceKey`). */
export const primaryInstance = async (cmd: Reader): Promise<EmsInstance> => {
  const key = await serviceKey(cmd, 'CFG_EMS_KEY', 'CFG_EMS_URL');
  const filesAddress = (cmd.env.CFG_EMS_FILES_ADDRESS ?? '').trim();
  return {
    name: PRIMARY,
    primary: true,
    url: (cmd.env.CFG_EMS_URL || DEFAULT_URL).replace(/\/+$/, ''),
    ...(key ? { key } : {}),
    ...(filesAddress ? { filesAddress } : {}),
  };
};

/** The instance called `name`, or undefined when there is none. */
export const readInstance = async (cmd: Reader, name: string): Promise<EmsInstance | undefined> => {
  if (name === PRIMARY) return await primaryInstance(cmd);
  if (!INSTANCE_NAME.test(name)) return undefined;
  const node = await readNode(cmd, name);
  return node ? { ...node, url: node.url.replace(/\/+$/, ''), name, primary: false } : undefined;
};

/** The names of the instances besides the primary, in name order. */
export const otherInstanceNames = async (cmd: Reader): Promise<string[]> => {
  const entries = await cmd.sys.vfs.children(ADMIN_ACCESS, INSTANCES_DIR).catch(() => []);
  return entries.map((entry) => entry.name).filter((name) => INSTANCE_NAME.test(name) && name !== PRIMARY).sort();
};

/** Every instance, the primary first. */
export const listInstances = async (cmd: Reader): Promise<EmsInstance[]> => {
  const others = await Promise.all((await otherInstanceNames(cmd)).map((name) => readInstance(cmd, name)));
  return [await primaryInstance(cmd), ...others.filter((instance): instance is EmsInstance => instance !== undefined)];
};

/** The name of the instance a command calls: `CFG_EMS_INSTANCE`, or the primary. */
export const instanceName = (cmd: Pick<Command, 'env'>): string => (cmd.env.CFG_EMS_INSTANCE ?? '').trim() || PRIMARY;

/**
 * The transcript signatures that count as current on an instance: the one it stamps now in each
 * place it can decode in (`transcribe_places`). Its card's share moves where it decodes at any
 * time, and a move is no reason to transcribe the archive again. An EMS that does not list the
 * places has its one signature.
 */
export const currentTranscripts = (capabilities: EmsCapabilities): string[] => {
  const places = capabilities.signatures?.transcribe_places?.filter((signature) => typeof signature === 'string' && signature);
  if (places?.length) return places;
  const now = capabilities.signatures?.transcribe;
  return typeof now === 'string' && now ? [now] : [];
};

/**
 * Which result of EMS each op's output is stamped with, in `capabilities`: a stored result stamped
 * otherwise is made again, so an instance that stamps an op differently from the primary must not
 * do it. An op not here stamps nothing EiN compares; a transcript is `TRANSCRIBED`'s.
 */
const GENERATION_OF: Record<string, (capabilities: EmsCapabilities) => unknown> = {
  'text.embed': (c) => c.models?.text_embed,
  'vision.embed': (c) => c.models?.image_embed,
  'vision.embed_text': (c) => c.models?.image_embed,
  'faces.detect': (c) => c.models?.faces,
  'faces.detect_video': (c) => c.models?.faces,
  'faces.embed': (c) => c.models?.faces,
  'ocr.read': (c) => c.models?.ocr,
};

/**
 * The op whose output another instance stamps as one the primary counts current
 * (`currentTranscripts`), wherever either decodes, or not at all.
 */
const TRANSCRIBED = 'speech.transcribe';

/**
 * The ops of `ops` that `other` stamps otherwise than `primary`: none means `other` may do them.
 * An op the primary does not serve has nothing to match.
 */
export const generationsDiffer = (primary: EmsCapabilities, other: EmsCapabilities, ops: string[]): string[] =>
  ops.filter((op) => {
    if (!(primary.ops ?? []).includes(op)) return false;
    if (op === TRANSCRIBED) {
      const current = currentTranscripts(primary);
      const stamp = other.signatures?.transcribe;
      return current.length > 0 ? !current.includes(stamp ?? '') : Boolean(stamp);
    }
    const generation = GENERATION_OF[op];
    return generation !== undefined && (generation(primary) ?? null) !== (generation(other) ?? null);
  });

/** Whether `other` serves every op of `ops` and stamps each the way `primary` does. */
export const sameGenerations = (primary: EmsCapabilities, other: EmsCapabilities, ops: string[]): boolean =>
  ops.every((op) => (other.ops ?? []).includes(op)) && generationsDiffer(primary, other, ops).length === 0;

/** The metrics series `base` (`gpu`, `ems-models`) of an instance: the primary's is `base`, another's `base-<name>`. */
export const instanceSeries = (base: string, name: string): string => name === PRIMARY ? base : `${base}-${name}`;
