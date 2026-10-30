/**
 * Text vectors: which space a vector is in, where it is kept, and which space search reads.
 *
 * The text space is EMS's configured embedder (`text.embed` `model: current`), in a type per
 * model and a node named after that type, beside the text it was made from:
 *
 *   <file>/metadata/content/text_jina5s              a file's extracted text, or for one longer
 *                                                    than CURRENT_TEXT_CHARS a directory of
 *                                                    parts, `c<N>` (`contentParts`)
 *   <file>/metadata/transcript/text_jina5s/t<second> a transcript chunk
 *   <file>/metadata/authored/text_jina5s             a hand-written description (`attrs.description`)
 *
 * A vector table's dimension is fixed when it is created and two models' vectors are not
 * comparable, so a model is a type and a new model is a new one; the names are written down
 * rather than derived because PostgreSQL cuts identifiers at 63 characters.
 *
 * The vectors are derived: what a text is and where it came from (a transcript's `transcribedBy`,
 * say) is on the text node, so a new model is a re-embed (`media-reembed`) and never a re-run of
 * what wrote the text. A transcript chunk's and an extracted text's vector nodes also carry the
 * words they were made from (`text`), which archive's `spoken_text` trigram index serves for a
 * phrase search.
 *
 * A search's words are embedded once per space and shared by every provider that ranks them: in
 * the text space (`embedQuery`), and in the pictures' through SigLIP2's text tower
 * (`embedPictureQuery`).
 */

import type { Command } from '@ein/client';
import { shq } from '@ein/client';
import { embedImageText, embedTexts } from './client.ts';

/** The current embedder's type, by the producer EMS reports. */
const CURRENT_TEXT_TYPES: Record<string, string> = {
  // jina-embeddings-v5-text-small: 1024 dimensions, stored as halfvec.
  'jina-embeddings-v5-text-small': 'text_jina5s',
};

/**
 * The type for a current-space vector from this producer, or undefined for a model nothing here
 * knows — a new model has to be given a type on purpose.
 */
export const textEmbeddingType = (producer: string): string | undefined => CURRENT_TEXT_TYPES[producer];

/** The node names current-space text vectors (or directories of chunk vectors) are kept at. */
export const TEXT_VECTOR_NAMES: string[] = Object.values(CURRENT_TEXT_TYPES);

/** Whether a node name is a current-space text vector (or a directory of chunk vectors). */
export const isTextVectorName = (name: string): boolean => TEXT_VECTOR_NAMES.includes(name);

/**
 * The lowest similarity a text hit is kept at: below it, precision on judged retrieval pairs
 * falls under one in two. The callers' `-t` threshold is not applied to this space.
 */
const CURRENT_TEXT_FLOOR = 0.35;

/**
 * The similarity at which a hit says what the query says. Paraphrases of something said in 20
 * recordings found theirs at 0.45-0.69, the best transcript hit of 47 picture queries was at
 * 0.35-0.64: from 0.55, 8 of the recordings reach the top 10 and one picture query takes a
 * recording (ein/core#524).
 */
const CURRENT_TEXT_CONFIDENT = 0.55;

/**
 * How long a query's vector is kept for the next caller with the same text: the providers of one
 * search ask within a second or two of each other, and its next page asks again.
 */
const QUERY_KEEP_MS = 60_000;
/** At most this many query vectors are kept; the oldest goes first. */
const QUERY_KEEP_MAX = 64;

/** The space a query is embedded into: the text space, or the pictures'. */
type QuerySpace = 'text' | 'picture';

/** A query's embed in one space, settled or in flight, and the command whose request it is. */
type QueryEmbed = { at: number; owner: Command; embedded: Promise<{ bytes: Uint8Array; producer: string }> };

/**
 * Query embeds by space, service and text, in module scope so every command in the process shares
 * them: one search runs several providers that rank the same query, and each would otherwise make
 * its own request.
 */
const queryEmbeds = new Map<string, QueryEmbed>();

/** The request that embeds `query` into `space`, made with `cmd`. */
const requestQueryEmbed = async (cmd: Command, space: QuerySpace, query: string): Promise<{ vector: number[]; producer: string }> => {
  if (space === 'picture') {
    const { embedding, producer } = await embedImageText(cmd, query, { interactive: true });
    return { vector: embedding, producer };
  }
  const { vectors, producer } = await embedTexts(cmd, [query], { role: 'query', interactive: true });
  return { vector: vectors[0], producer };
};

/** The live embed of `query` in `space`, or a new request made with `cmd`. A failed request is not kept. */
const queryEmbed = (cmd: Command, space: QuerySpace, query: string): QueryEmbed => {
  const now = Date.now();
  for (const [key, entry] of queryEmbeds) {
    if (now - entry.at > QUERY_KEEP_MS) queryEmbeds.delete(key);
  }
  const key = `${space}\n${cmd.env.CFG_EMS_URL ?? ''}\n${query}`;
  const live = queryEmbeds.get(key);
  if (live) return live;

  const embedded = requestQueryEmbed(cmd, space, query)
    .then(({ vector, producer }) => ({ bytes: new TextEncoder().encode(JSON.stringify(vector)), producer }));
  const entry: QueryEmbed = { at: now, owner: cmd, embedded };
  embedded.catch(() => {
    if (queryEmbeds.get(key) === entry) queryEmbeds.delete(key);
  });
  queryEmbeds.set(key, entry);
  if (queryEmbeds.size > QUERY_KEEP_MAX) queryEmbeds.delete(queryEmbeds.keys().next().value!);
  return entry;
};

/**
 * `query` as a vector in `space`, and the model that made it, through the shared request
 * (`queryEmbed`). A request is tied to the command that made it and ends when that command is
 * interrupted; a caller that was waiting on it then asks again with its own.
 */
const sharedQueryEmbed = async (cmd: Command, space: QuerySpace, query: string): Promise<{ bytes: Uint8Array; producer: string }> => {
  for (;;) {
    const entry = queryEmbed(cmd, space, query);
    try {
      return await entry.embedded;
    } catch (error) {
      if (entry.owner !== cmd && entry.owner.interrupted && !cmd.interrupted) continue;
      throw error;
    }
  }
};

/**
 * A search query as a vector, the type to search, the floor a hit has to reach and the similarity
 * from which a hit is confident. Callers with the same text share one request.
 */
export const embedQuery = async (cmd: Command, query: string): Promise<{ bytes: Uint8Array; type: string; floor: number; confident: number }> => {
  const embedded = await sharedQueryEmbed(cmd, 'text', query);
  const type = textEmbeddingType(embedded.producer);
  if (!type) throw new Error(`no embedding type for text embedder "${embedded.producer}"`);
  return { bytes: embedded.bytes, type, floor: CURRENT_TEXT_FLOOR, confident: CURRENT_TEXT_CONFIDENT };
};

/**
 * A search query as a vector in the pictures' space, and the model that made it, whose type the
 * caller knows. Shared as `embedQuery`'s is.
 */
export const embedPictureQuery = (cmd: Command, query: string): Promise<{ bytes: Uint8Array; producer: string }> => sharedQueryEmbed(cmd, 'picture', query);

/**
 * How long a person's save waits for one `text.embed` request. A warm embedder answers a batch
 * in well under a second; past this the text is saved without its vector, which `media-scan`
 * finds missing and `media-reembed` fills in.
 */
const SAVE_TIMEOUT_SECONDS = 10;

/**
 * How a text is embedded for storing. `interactive` is for a save a person waits on: ahead of
 * batch work in EMS's queues, failing at once when EMS is away and after SAVE_TIMEOUT_SECONDS
 * when it is wedged, instead of retrying the connection as batch work does.
 */
export type StoreOptions = { interactive?: boolean };

/** Texts as current-space vectors for storing, with their type and producer. */
export const embedForStore = async (cmd: Command, texts: string[], opts: StoreOptions = {}): Promise<{ vectors: number[][]; type: string; producer: string }> => {
  const { vectors, producer } = await embedTexts(cmd, texts, { role: 'document', ...(opts.interactive ? { interactive: true, timeoutSeconds: SAVE_TIMEOUT_SECONDS } : {}) });
  const type = textEmbeddingType(producer);
  if (!type) throw new Error(`no embedding type for text embedder "${producer}"`);
  return { vectors, type, producer };
};

/**
 * Write one vector node at `<parent>/<name>`, replacing what is there.
 *
 * A node of another embedding type is removed first rather than retyped: retyping leaves its row
 * in the old type's table. `attrs` ride on the node beside `embeddingType` and `capacity`.
 */
export const writeTextVector = async (
  cmd: Command,
  parent: string,
  name: string,
  type: string,
  vector: number[],
  attrs: Record<string, unknown> = {},
): Promise<void> => {
  const path = `${parent}/${name}`;
  const nodeAttrs = { ...attrs, embeddingType: type, capacity: vector.length };
  let existing: { attrs: Record<string, unknown> } | undefined;
  try {
    existing = await cmd.sys.vfs.get(cmd.access, path) as { attrs: Record<string, unknown> };
  } catch {
    existing = undefined;
  }
  if (existing && existing.attrs.embeddingType !== type) {
    await cmd.sys.vfs.unlink(cmd.access, path, parent, { recursive: true });
    existing = undefined;
  }
  if (existing) await cmd.sys.vfs.update(cmd.access, path, { attrs: nodeAttrs });
  else await cmd.sys.vfs.createTree(cmd.access, parent, [{ type: 'embedding', name, attrs: nodeAttrs }]);

  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(JSON.stringify(vector)));
  } finally {
    await handle.close();
  }
};

/**
 * Embed one text into the current space and keep it at `<parent>/<type>`, stamped with the
 * producer. The answer is why it did not, for the caller to report; `media-reembed` fills what is
 * missing.
 */
const storeCurrentText = async (
  cmd: Command,
  parent: string,
  text: string,
  attrs: Record<string, unknown> = {},
  opts: StoreOptions = {},
): Promise<string | undefined> => {
  try {
    const { vectors, type, producer } = await embedForStore(cmd, [text], opts);
    const embeddedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    await writeTextVector(cmd, parent, type, type, vectors[0], { ...attrs, embeddedBy: producer, embeddedAt });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * The longest text embedded as one vector: a hand-written description, a photo's
 * text and a short document fit whole; an extracted text longer than this is embedded in parts
 * (`contentParts`). Characters, not tokens, because only EMS has the tokenizer: 6000 characters
 * stays well inside its 8192-token limit even for text that tokenizes densely.
 */
export const CURRENT_TEXT_CHARS = 6000;

/** The part of a file's extracted text its current-space vector is made from. */
export const currentTextOf = (text: string): string => text.slice(0, CURRENT_TEXT_CHARS).trim();

/** Texts per `text.embed` request when storing: EMS takes 256, and a request is one model-slot wait. */
const STORE_BATCH = 32;

/** One chunk of a longer text: its node name, its text, and what rides on its vector node. */
export type TextChunk = { name: string; text: string; attrs?: Record<string, unknown> };

/**
 * A part of a long extracted text: about 400 tokens, so a page's worth of a long document is one
 * vector instead of the whole document being its first 6000 characters. 1600 characters is ~400
 * tokens of Swedish or English prose.
 */
export const CONTENT_PART_CHARS = 1600;

/**
 * At most this many parts; a longer text gets longer parts instead of losing its end, as
 * transcripts do.
 */
export const CONTENT_MAX_PARTS = 400;

/**
 * A long extracted text cut into parts named `c0`, `c1`, …: whole paragraphs where they fit,
 * sentences where a paragraph does not, and a hard cut only for a sentence longer than a part.
 * Each part carries its character offset into the text (`offset`).
 */
export const contentParts = (text: string): TextChunk[] => {
  const size = Math.min(CURRENT_TEXT_CHARS, Math.max(CONTENT_PART_CHARS, Math.ceil(text.length / CONTENT_MAX_PARTS)));

  // Pieces no longer than a part, each with where it starts in the text.
  const pieces: { at: number; text: string }[] = [];
  const add = (at: number, piece: string) => {
    for (let from = 0; from < piece.length; from += size) pieces.push({ at: at + from, text: piece.slice(from, from + size) });
  };
  for (const paragraph of text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)) {
    const body = paragraph[0].trim();
    if (body.length <= size) {
      add(paragraph.index, body);
      continue;
    }
    for (const sentence of body.matchAll(/\S[\s\S]*?(?:[.!?](?=\s)|$)/g)) add(paragraph.index + sentence.index, sentence[0].trim());
  }

  const parts: TextChunk[] = [];
  let current: { at: number; text: string } | undefined;
  const flush = () => {
    if (current) parts.push({ name: `c${parts.length}`, text: current.text, attrs: { offset: current.at } });
    current = undefined;
  };
  for (const piece of pieces) {
    if (current && current.text.length + 2 + piece.text.length > size) flush();
    current = current ? { at: current.at, text: `${current.text}\n\n${piece.text}` } : { ...piece };
  }
  flush();
  return parts.slice(0, CONTENT_MAX_PARTS);
};

/** Whether a node name is one of `contentParts`'. */
export const isContentPartName = (name: string): boolean => /^c\d+$/.test(name);

/**
 * Embed a set of chunks into the current space and keep them under `<parent>/<type>/`, replacing
 * whatever set was there — re-chunked text moves the boundaries, so old names are not a subset of
 * the new ones. The directory is stamped with the producer last, so an interrupted run leaves a
 * directory without `embeddedBy` for the next run to redo. Answers why it did not, or undefined.
 */
export const storeCurrentChunks = async (
  cmd: Command,
  parent: string,
  chunks: TextChunk[],
  attrs: Record<string, unknown> = {},
  opts: StoreOptions = {},
): Promise<string | undefined> => {
  if (chunks.length === 0) {
    // Nothing to embed, but a set from before (a re-transcribed file that turned out silent) must
    // not outlive the text it was made from.
    try {
      for (const name of TEXT_VECTOR_NAMES) {
        if (await cmd.sys.vfs.exists(cmd.access, `${parent}/${name}`)) await cmd.sys.vfs.unlink(cmd.access, `${parent}/${name}`, parent, { recursive: true });
      }
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  try {
    const vectors: number[][] = [];
    let type = '';
    let producer = '';
    for (let at = 0; at < chunks.length; at += STORE_BATCH) {
      const batch = await embedForStore(cmd, chunks.slice(at, at + STORE_BATCH).map((chunk) => chunk.text), opts);
      vectors.push(...batch.vectors);
      ({ type, producer } = batch);
    }

    const dir = `${parent}/${type}`;
    if (await cmd.sys.vfs.exists(cmd.access, dir)) await cmd.sys.vfs.unlink(cmd.access, dir, parent, { recursive: true });
    await cmd.sys.vfs.createTree(cmd.access, parent, [{
      type: 'directory',
      name: type,
      children: chunks.map((chunk, index) => ({
        type: 'embedding',
        name: chunk.name,
        attrs: { ...chunk.attrs, embeddingType: type, capacity: vectors[index].length },
      })),
    }]);
    for (const [index, chunk] of chunks.entries()) {
      const handle = await cmd.sys.vfs.open(cmd.access, `${dir}/${chunk.name}`, { mode: 'w' });
      try {
        await handle.write(new TextEncoder().encode(JSON.stringify(vectors[index])));
      } finally {
        await handle.close();
      }
    }
    const embeddedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    await cmd.sys.vfs.update(cmd.access, dir, { attrs: { ...attrs, embeddedBy: producer, embeddedAt } });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * A file's hand-written description, the person's own words in `attrs.description`: the most
 * precise text the archive has (who is in the frame), and the one no model can recover.
 * The text stays in the attr, which the lightbox and every other reader use; only its vector is
 * stored, at `<file>/metadata/authored/<type>`, current space only. The vector carries a hash of
 * the text it was made from, so an edited description reads as stale (`authoredStale`).
 */
export const authoredParent = (file: string): string => `${file}/metadata/authored`;

/** The hash an authored vector carries of the text it was made from. */
export const authoredHash = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Whether `<file>`'s authored vector is missing, from another model, or from other text. */
export const authoredStale = async (cmd: Command, file: string, text: string, producer: string, type: string): Promise<boolean> => {
  const node = await cmd.sys.vfs.get(cmd.access, `${authoredParent(file)}/${type}`).catch(() => undefined);
  return node?.attrs.embeddedBy !== producer || node?.attrs.authoredHash !== await authoredHash(text);
};

/**
 * Keep `<file>`'s authored vector in step with its description: embed `text`, or remove the
 * vector when the description was cleared. Answers why it did not, or undefined; a description
 * that could not be embedded is still saved, and `media-reembed` fills the vector in later.
 */
export const storeAuthoredText = async (cmd: Command, file: string, text: string, opts: StoreOptions = {}): Promise<string | undefined> => {
  const parent = authoredParent(file);
  try {
    if (!text) {
      if (await cmd.sys.vfs.exists(cmd.access, parent)) await cmd.sys.vfs.unlink(cmd.access, parent, `${file}/metadata`, { recursive: true });
      return undefined;
    }
    const made = await cmd.execute(`mkdir -p ${shq(parent)}`);
    if (made.code !== 0) return `cannot create ${parent}: ${made.stderr.trim()}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return await storeCurrentText(cmd, parent, currentTextOf(text), { authoredHash: await authoredHash(text) }, opts);
};

/**
 * Embed a file's extracted text into the current space at `<parent>/<type>`: one vector when it
 * fits CURRENT_TEXT_CHARS, a directory of parts (`contentParts`) when it does not, each vector node
 * with its words in `text`. Answers why it did not, or undefined.
 */
export const storeCurrentContent = async (
  cmd: Command,
  parent: string,
  text: string,
  attrs: Record<string, unknown> = {},
  opts: StoreOptions = {},
): Promise<string | undefined> => {
  const trimmed = text.trim();
  if (trimmed.length <= CURRENT_TEXT_CHARS) return await storeCurrentText(cmd, parent, trimmed, { ...attrs, text: trimmed }, opts);
  const parts = contentParts(trimmed).map((part) => ({ ...part, attrs: { ...part.attrs, text: part.text } }));
  return await storeCurrentChunks(cmd, parent, parts, attrs, opts);
};
