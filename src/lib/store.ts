/**
 * Serve-time reading of the built artefacts: load the in-memory tables the
 * server holds (manifest, catalog, vocab, units, postings), read block content
 * from each edition's blocks.jsonl on demand, and resolve catalog slugs to
 * entries. The build side (builder.ts) writes what this module reads; both
 * share the on-disk format defined in artefacts.ts.
 *
 * Block content is fetched lazily: a single search hit by byte range
 * (readUnitBlock), and the text/compare routes a whole edition at a time under
 * a small LRU (createBlockStore). The text blobs and token streams are never
 * loaded — they exist for future corpus analysis and for rebuilding the index.
 */

import type { Block } from "@earlytexts/markit";
import {
  type AuthorEntry,
  type CatalogArtefact,
  editionDir,
  type EditionEntry,
  type Manifest,
  PIPELINE_VERSION,
  type Postings,
  type ServeArtefacts,
  type UnitTable,
  type Vocab,
  type WorkEntry,
} from "./artefacts.ts";

/* ------------------------------- load ------------------------------- */

export const loadServeArtefacts = async (
  dir: string,
): Promise<ServeArtefacts> => {
  const manifest = JSON.parse(
    await Deno.readTextFile(`${dir}/manifest.json`),
  ) as Manifest;
  if (manifest.pipelineVersion !== PIPELINE_VERSION) {
    throw new Error(
      `artefacts in ${dir} were built by pipeline ` +
        `${manifest.pipelineVersion}; this is ${PIPELINE_VERSION}`,
    );
  }
  const catalog = JSON.parse(
    await Deno.readTextFile(`${dir}/catalog.json`),
  ) as CatalogArtefact;
  const vocab = JSON.parse(
    await Deno.readTextFile(`${dir}/vocab.json`),
  ) as Vocab;
  const units = JSON.parse(
    await Deno.readTextFile(`${dir}/units.json`),
  ) as UnitTable;
  const split = vocab.surfaces.length + 1;
  const readPostings = async (name: string): Promise<Postings> => {
    const bin = await Deno.readFile(`${dir}/${name}`);
    const words = new Uint32Array(bin.buffer, bin.byteOffset, bin.length / 4);
    return { offsets: words.subarray(0, split), pairs: words.subarray(split) };
  };
  const postings = await readPostings("postings.bin");
  const overlayPostings = await readPostings("postings-original.bin");
  const overlay = JSON.parse(
    await Deno.readTextFile(`${dir}/overlay.json`),
  ) as { affectedUnits: number[] };
  const affectedUnits = new Set(overlay.affectedUnits);
  const spellingSurfaces: number[][] = vocab.spellings.map(() => []);
  for (let id = 0; id < vocab.surfaceSpelling.length; id++) {
    spellingSurfaces[vocab.surfaceSpelling[id]].push(id);
  }
  const formSurfaces: number[][] = vocab.forms.map(() => []);
  for (let id = 0; id < vocab.surfaceForm.length; id++) {
    formSurfaces[vocab.surfaceForm[id]].push(id);
  }
  // Units are written to each edition's blocks.jsonl in the order they appear
  // in units.edition, so this groups them in blocks.jsonl line order.
  const editionUnits: number[][] = manifest.editions.map(() => []);
  for (let unit = 0; unit < units.edition.length; unit++) {
    editionUnits[units.edition[unit]].push(unit);
  }
  return {
    dir,
    manifest,
    catalog,
    vocab,
    units,
    postings,
    overlayPostings,
    affectedUnits,
    spellingSurfaces,
    formSurfaces,
    editionUnits,
  };
};

/** Read one unit's compiled block from its edition's blocks.jsonl. */
export const readUnitBlock = async (
  artefacts: ServeArtefacts,
  unitIndex: number,
): Promise<Block> => {
  const ref = artefacts.manifest.editions[artefacts.units.edition[unitIndex]];
  const path = `${artefacts.dir}/${editionDir(ref)}/blocks.jsonl`;
  const buffer = new Uint8Array(artefacts.units.byteLength[unitIndex]);
  const file = await Deno.open(path, { read: true });
  try {
    await file.seek(artefacts.units.byteOffset[unitIndex], Deno.SeekMode.Start);
    let read = 0;
    while (read < buffer.length) {
      const n = await file.read(buffer.subarray(read));
      if (n === null) throw new Error(`unexpected EOF in ${path}`);
      read += n;
    }
  } finally {
    file.close();
  }
  return JSON.parse(new TextDecoder().decode(buffer)) as Block;
};

/* --------------------------- block store ----------------------------- */

/** Read and parse a whole edition's blocks, keyed by unit index. */
const readEditionBlocks = async (
  artefacts: ServeArtefacts,
  editionIndex: number,
): Promise<Map<number, Block>> => {
  const blocks = new Map<number, Block>();
  const ref = artefacts.manifest.editions[editionIndex];
  const unitIndices = artefacts.editionUnits[editionIndex] ?? [];
  let text: string;
  try {
    text = await Deno.readTextFile(
      `${artefacts.dir}/${editionDir(ref)}/blocks.jsonl`,
    );
  } catch {
    return blocks; // a stub edition has no blocks file
  }
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
 */
export type BlockStore = {
  /** The compiled block at a unit index. */
  block: (unitIndex: number) => Promise<Block>;
  /** The compiled blocks at several unit indices, in the given order. */
  blocks: (unitIndices: number[]) => Promise<Block[]>;
};

export const createBlockStore = (
  artefacts: ServeArtefacts,
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
    const loading = readEditionBlocks(artefacts, editionIndex);
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
  return {
    block,
    blocks: (unitIndices) => Promise.all(unitIndices.map(block)),
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
