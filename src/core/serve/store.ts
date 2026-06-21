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
  type Dtm,
  DTM_BIN,
  DTM_JSON,
  editionDir,
  type EditionEntry,
  parseDtm,
  parseTopics,
  type ServeArtefacts,
  type Topics,
  TOPICS_BIN,
  TOPICS_JSON,
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
  /** A whole binary file (the edition's tokens.bin), or null when absent. */
  readBytes: (relPath: string) => Promise<Uint8Array | null>;
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

/* --------------------------- token store ----------------------------- */

/**
 * Reads the ordered token stream for the collocations route, which (unlike the
 * inverted index) needs to know what stands next to a given token. Each
 * edition's tokens.bin is `(surface id, char offset)` Uint32 pairs in reading
 * order; a unit's tokens are the contiguous run after the token counts of the
 * units before it in the edition (units are written in blocks.jsonl order, the
 * order they were tokenized). Whole editions are cached under a small LRU — a
 * collocation query touches only the node word's units, clustered in a handful
 * of editions — and only the surface ids are returned (the char offsets serve
 * future work).
 */
export type TokenStore = {
  /** The surface ids of a unit's tokens, in reading order. */
  unitSurfaces: (unitIndex: number) => Promise<Uint32Array>;
};

export const createTokenStore = (
  artefacts: ServeArtefacts,
  reader: BlockReader,
  maxEditions = 8,
): TokenStore => {
  // First token (pair) index of every unit within its edition's stream.
  const unitTokenStart = new Int32Array(artefacts.units.edition.length);
  for (const unitIndices of artefacts.editionUnits) {
    let at = 0;
    for (const unit of unitIndices) {
      unitTokenStart[unit] = at;
      at += artefacts.units.tokenCount[unit];
    }
  }

  const cache = new Map<number, Promise<Uint32Array>>();
  const editionTokens = (editionIndex: number): Promise<Uint32Array> => {
    const cached = cache.get(editionIndex);
    if (cached !== undefined) {
      cache.delete(editionIndex); // reinsert as most-recently-used
      cache.set(editionIndex, cached);
      return cached;
    }
    const ref = artefacts.manifest.editions[editionIndex];
    const loading = reader.readBytes(`${editionDir(ref)}/tokens.bin`).then(
      (bytes) =>
        bytes === null
          ? new Uint32Array(0)
          // Copy to a fresh buffer so the Uint32 view is always 4-aligned.
          : new Uint32Array(bytes.slice().buffer),
    );
    cache.set(editionIndex, loading);
    while (cache.size > maxEditions) {
      cache.delete(cache.keys().next().value!);
    }
    return loading;
  };

  return {
    unitSurfaces: async (unitIndex) => {
      const words = await editionTokens(artefacts.units.edition[unitIndex]);
      const count = artefacts.units.tokenCount[unitIndex];
      const start = unitTokenStart[unitIndex];
      const surfaces = new Uint32Array(count);
      for (let k = 0; k < count; k++) surfaces[k] = words[(start + k) * 2];
      return surfaces;
    },
  };
};

/* ---------------------------- DTM store ------------------------------ */

/**
 * Reads the document-term matrix for the similarity route. Unlike the tables in
 * ServeArtefacts (loaded at boot by parseArtefacts), the DTM sits on disk and is
 * read on first use, exactly as tokens.bin is — it is large and only the vector
 * routes need it. The whole matrix is parsed once (via parseDtm) and cached for
 * the process: it is read-only and shared by every request, so there is nothing
 * to evict.
 */
export type DtmStore = {
  /** The parsed DTM, read and cached on first call. */
  matrix: () => Promise<Dtm>;
};

export const createDtmStore = (reader: BlockReader): DtmStore => {
  let cached: Promise<Dtm> | undefined;
  const load = async (): Promise<Dtm> => {
    const [json, bin] = await Promise.all([
      reader.readBytes(DTM_JSON),
      reader.readBytes(DTM_BIN),
    ]);
    if (json === null || bin === null) {
      throw new Error("DTM artefact is missing (rebuild the artefacts)");
    }
    return parseDtm(json, bin);
  };
  return { matrix: () => cached ??= load() };
};

/* --------------------------- topics store ---------------------------- */

/**
 * Reads the topic model for the topic routes. Like the DTM (and tokens.bin), the
 * topic artefact sits on disk and is read on first use, parsed once via
 * parseTopics, and cached for the process — read-only and shared by every
 * request.
 */
export type TopicsStore = {
  /** The parsed topic model, read and cached on first call. */
  model: () => Promise<Topics>;
};

export const createTopicsStore = (reader: BlockReader): TopicsStore => {
  let cached: Promise<Topics> | undefined;
  const load = async (): Promise<Topics> => {
    const [json, bin] = await Promise.all([
      reader.readBytes(TOPICS_JSON),
      reader.readBytes(TOPICS_BIN),
    ]);
    if (json === null || bin === null) {
      throw new Error(
        "topic-model artefact is missing (rebuild the artefacts)",
      );
    }
    return parseTopics(json, bin);
  };
  return { model: () => cached ??= load() };
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
