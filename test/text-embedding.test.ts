/**
 * `contentParts`: a long extracted text cut into parts a page or so long, at paragraph and then
 * sentence boundaries, every character of it in some part.
 */

import { assert, assertEquals } from '@std/assert';
import { CONTENT_MAX_PARTS, CONTENT_PART_CHARS, contentParts } from '../lib/text-embedding.ts';

const paragraph = (n: number) => `Stycke ${n}. ${'En båt seglade förbi udden i morse. '.repeat(10)}`.trim();

Deno.test('paragraphs are packed whole into parts no longer than a part', () => {
  const text = Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n\n');
  const parts = contentParts(text);
  assertEquals(parts.map((part) => part.name), parts.map((_, i) => `c${i}`));
  assert(parts.every((part) => part.text.length <= CONTENT_PART_CHARS));
  // Each part starts at a paragraph, and its offset points there.
  for (const part of parts) assertEquals(text.slice(part.attrs!.offset as number).startsWith(part.text.slice(0, 20)), true);
  assertEquals(parts.map((part) => part.text).join('\n\n'), text);
});

Deno.test('a paragraph longer than a part is cut at sentences, and a sentence longer than one is cut hard', () => {
  const sentences = contentParts('Ett långt stycke utan radbrytningar. '.repeat(200));
  assert(sentences.length > 1 && sentences.every((part) => part.text.endsWith('.')));

  const unbroken = contentParts('x'.repeat(5000));
  assertEquals(unbroken.map((part) => part.text.length), [1600, 1600, 1600, 200]);
});

Deno.test('a very long text gets longer parts rather than losing its end', () => {
  const text = Array.from({ length: 3000 }, (_, i) => paragraph(i)).join('\n\n');
  const parts = contentParts(text);
  assert(parts.length <= CONTENT_MAX_PARTS, String(parts.length));
  assert(parts.at(-1)!.text.endsWith(paragraph(2999).slice(-30)));
});
