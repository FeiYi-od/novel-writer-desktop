import { deflateSync } from 'node:zlib';
import type { CharacterCard } from '../shared/contracts';
import { buildCardV2, buildCardV3, parseCard, parseCardBook, type CardFields, type StCard } from '../core/st-cards';
import { embedCard, readCardJson, writeChunks } from '../core/png-text';

/** Minimal 1×1 transparent PNG used when a card has no portrait (SillyTavern needs an image file). */
export function placeholderPng(): Uint8Array {
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = new Uint8Array(deflateSync(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])));
  return writeChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: idat }, { type: 'IEND', data: new Uint8Array() }]);
}
const stringList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const record = (value: unknown) => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
/** Maps our card onto the SillyTavern V2 data block; unknown studio fields are kept in extensions. */
export function toStFields(card: CharacterCard): CardFields {
  const raw = record(card.raw);
  const rawData = record(raw.data);
  const extensions = { ...record(rawData.extensions ?? raw.extensions), ...(card.portrait ? {} : {}) };
  return {
    name: card.name, description: card.description, personality: card.personality, scenario: card.scenario,
    firstMessage: card.firstMessage, exampleDialogue: card.examples, creatorNotes: card.creatorNotes,
    systemPrompt: card.systemPrompt, postHistoryInstructions: card.postHistoryInstructions,
    alternateGreetings: [...card.alternateGreetings], tags: stringList(rawData.tags ?? raw.tags),
    creator: String(rawData.creator ?? raw.creator ?? ''), characterVersion: String(rawData.character_version ?? raw.character_version ?? '1.0'),
    extensions
  };
}
/** Exports a card as a SillyTavern-ready PNG (V2 in `chara`, V3 in `ccv3`). */
export function exportCardPng(card: CharacterCard, basePng?: Uint8Array): Uint8Array {
  const fields = toStFields(card);
  const raw = record(card.raw);
  const embedded = record(raw.data).character_book ?? raw.character_book;
  const book = embedded ? parseCardBook(embedded) : undefined;
  return embedCard(basePng ?? placeholderPng(), buildCardV2(fields, book), buildCardV3(fields, book));
}
/** Reads a PNG or a raw JSON card and returns what the import flow needs. */
export function readExportedCard(input: Uint8Array): StCard {
  return parseCard(readCardJson(input));
}
export function cardToFields(card: StCard) {
  const data = card.data;
  return {
    fields: {
      name: data.name, description: data.description, personality: data.personality, scenario: data.scenario,
      firstMessage: data.firstMessage, examples: data.exampleDialogue, creatorNotes: data.creatorNotes,
      systemPrompt: data.systemPrompt, postHistoryInstructions: data.postHistoryInstructions,
      alternateGreetings: [...data.alternateGreetings]
    },
    specVersion: card.specVersion,
    characterBook: card.characterBook ?? null
  };
}
