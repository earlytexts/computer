/**
 * Serve-time block access and catalog lookups. The in-memory tables are parsed
 * by artefacts.ts (parseArtefacts); this module reads block content lazily
 * through an injected BlockReader and resolves catalog slugs to entries.
 *
 * Block content is fetched lazily: a single search hit by byte range
 * (BlockStore.unitBlock), and the text/compare routes a whole edition at a time
 * under a small LRU (block/blocks). The text blobs and token streams are never
 * loaded — they exist for future corpus analysis and for rebuilding the index.
 */

import type { Block } from "@earlytexts/markit";
import {
  type AuthorEntry,
  type CatalogArtefact,
  editionDir,
  type EditionEntry,
  type ServeArtefacts,
  type WorkEntry,
} from "../artefacts.ts";

/* ------------------------------- reader ------------------------------ */

/**
 * The one filesystem capability the serve side needs after boot: read an
 * edition's blocks.jsonl (paths are relative to the artefacts root; the reader
 * owns the root). The io adapter supplies the Deno-backed implementation; tests
 * supply an in-memory one.
 */
export type BlockReader = {
  /** The whole file as text, or null when the edition has no blocks (a stub). */
  readText: (relPath: string) => Promise<string | null>;
  /** `length` bytes at `offset` (a single block's line, for search hits). */
  readRange: (
    relPath: string,
    offset: number,
    length: number,
  ) => Promise<Uint8Array>;
};

/* --------------------------- block store ----------------------------- */

/** Read and parse a whole edition's blocks, keyed by unit index. */
const readEditionBlocks = async (
  artefacts: ServeArtefacts,
  reader: BlockReader,
  editionIndex: number,
): Promise<Map<number, Block>> => {
  const blocks = new Map<number, Block>();
  const ref = artefacts.manifest.editions[editionIndex];
  const unitIndices = artefacts.editionUnits[editionIndex] ?? [];
  const text = await reader.readText(`${editionDir(ref)}/blocks.jsonl`);
  if (text === null) return blocks; // a stub edition has no blocks file
  let line = 0;
  for (const json of text.split("\n")) {
    if (json === "") continue;
    blocks.set(unitIndices[line], JSON.parse(json) as Block);
    line++;
  }
  return blocks;
};

/**
 * Reads block content for the text and compare routes, caching whole editions
 * (parsed blocks.jsonl) under a small LRU. A request touches one edition (or
 * two, when comparing, plus any borrowed in composite editions), so a handful
 * of cached editions covers concurrent reads without holding the whole corpus.
 * `unitBlock` bypasses the LRU to read a single block by byte range, for search
 * hits that touch one block each across many editions.
 */
export type BlockStore = {
  /** The compiled block at a unit index. */
  block: (unitIndex: number) => Promise<Block>;
  /** The compiled blocks at several unit indices, in the given order. */
  blocks: (unitIndices: number[]) => Promise<Block[]>;
  /** One unit's compiled block, read directly by byte range (no caching). */
  unitBlock: (unitIndex: number) => Promise<Block>;
};

export const createBlockStore = (
  artefacts: ServeArtefacts,
  reader: BlockReader,
  maxEditions = 8,
): BlockStore => {
  const cache = new Map<number, Promise<Map<number, Block>>>();
  const edition = (editionIndex: number): Promise<Map<number, Block>> => {
    const cached = cache.get(editionIndex);
    if (cached !== undefined) {
      cache.delete(editionIndex); // reinsert as most-recently-used
      cache.set(editionIndex, cached);
      return cached;
    }
    const loading = readEditionBlocks(artefacts, reader, editionIndex);
    cache.set(editionIndex, loading);
    while (cache.size > maxEditions) {
      cache.delete(cache.keys().next().value!);
    }
    return loading;
  };
  const block = async (unitIndex: number): Promise<Block> => {
    const blocks = await edition(artefacts.units.edition[unitIndex]);
    const found = blocks.get(unitIndex);
    if (found === undefined) throw new Error(`no block for unit ${unitIndex}`);
    return found;
  };
  const unitBlock = async (unitIndex: number): Promise<Block> => {
    const ref = artefacts.manifest.editions[artefacts.units.edition[unitIndex]];
    const bytes = await reader.readRange(
      `${editionDir(ref)}/blocks.jsonl`,
      artefacts.units.byteOffset[unitIndex],
      artefacts.units.byteLength[unitIndex],
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as Block;
  };
  return {
    block,
    blocks: (unitIndices) => Promise.all(unitIndices.map(block)),
    unitBlock,
  };
};

/* --------------------------- catalog lookup -------------------------- */

export const findAuthorEntry = (
  catalog: CatalogArtefact,
  authorSlug: string,
): AuthorEntry | undefined =>
  catalog.authors.find((a) => a.meta.slug === authorSlug);

export const findWorkEntry = (
  author: AuthorEntry,
  workSlug: string,
): WorkEntry | undefined => author.works.find((w) => w.meta.slug === workSlug);

export const findEditionEntry = (
  work: WorkEntry,
  editionSlug: string,
): EditionEntry | undefined =>
  work.editions.find((e) => e.meta.slug === editionSlug);
