/**
 * The build pipeline: derived artefacts built from the corpus, written to
 * disk (gitignored), and loaded by the server.
 *
 * Layout of the artefacts directory:
 *
 *   manifest.json    pipeline version, corpus fingerprint, edition list,
 *                    stats, build warnings
 *   vocab.json       the type table: distinct surface forms with document/
 *                    collection frequencies, normalised forms, lemma slot
 *   units.json       one row per block (columnar): location, token count,
 *                    offsets into the per-edition text and block files
 *   postings.bin     inverted index: per surface type, (unit, position)
 *                    pairs as little-endian Uint32
 *   editions/<author>/<work>/<edition>/
 *     blocks.jsonl   one compiled block per line, in unit order (units.json
 *                    holds byte ranges, so single blocks are read directly)
 *     text.txt       extracted plain text of every unit, "\n"-terminated
 *     tokens.bin     token stream: (surface type, char offset) Uint32 pairs
 *
 * The invariant everything rests on: text.txt is exactly the output of
 * blockText over blocks.jsonl, and every offset in tokens.bin/units.json
 * points into it. The pipeline version (extraction + tokenizer) is stamped
 * into the manifest; artefacts from another version are never served.
 *
 * The serve-time loader reads only the manifest, vocab, units, and postings
 * (tens of MB); blocks are fetched by byte range per search hit, and the
 * text blobs and token streams are not loaded at all (they exist for future
 * corpus analysis and for rebuilding the index quickly).
 */

import type { Block, MarkitDocument } from "@earlytexts/markit";
import {
  type Catalog,
  childSlug,
  type Edition,
  lastSegment,
  type Work,
} from "./catalog.ts";
import { blockText, EXTRACTION_VERSION } from "./text.ts";
import { normalizeSurface, tokenize, TOKENIZER_VERSION } from "./tokenize.ts";

export const PIPELINE_VERSION = `x${EXTRACTION_VERSION}.t${TOKENIZER_VERSION}`;

/* ------------------------------- types ------------------------------- */

export type EditionRef = {
  author: string;
  authorName: string; // surname, for display
  work: string;
  workBreadcrumb: string;
  edition: string; // "main" or a year slug
};

export type CorpusScan = {
  /** Number of .mit files in the corpus. */
  files: number;
  /** Most recent modification time (ms since epoch). */
  modified: number;
};

export type Manifest = {
  pipelineVersion: string;
  builtAt: string;
  corpus: CorpusScan;
  stats: {
    authors: number;
    works: number;
    editions: number;
    units: number;
    tokens: number;
    surfaces: number;
    norms: number;
  };
  /** Distinct edition slugs across the catalog (for filter UIs). */
  editionSlugs: string[];
  /** Every edition, in catalog order; units.edition indexes into this. */
  editions: EditionRef[];
  warnings: string[];
};

/**
 * The type table. Surface forms are the distinct case-folded spellings in
 * the corpus, lexicographically sorted (so prefix queries can binary
 * search); norms are their distinct normalised forms, also sorted. The
 * lemma column is an identity mapping until lemmatisation lands — it exists
 * so that adding lemmas rewrites this small file and nothing else.
 */
export type Vocab = {
  surfaces: string[];
  /** surface index -> index into norms */
  surfaceNorm: number[];
  /** number of units containing each surface */
  df: number[];
  /** total occurrences of each surface */
  cf: number[];
  norms: string[];
  /** norm index -> lemma index (identity for now) */
  normLemma: number[];
};

/** One row per block of every edition, as parallel (columnar) arrays. */
export type UnitTable = {
  /** index into manifest.editions */
  edition: number[];
  /** "/"-joined section slugs; "" for an edition's own (title) blocks */
  sectionPath: string[];
  sectionTitle: string[];
  blockId: string[];
  /** 1 for title/subtitle blocks (weighted in ranking) */
  isTitle: number[];
  tokenCount: number[];
  /** character range in the edition's text.txt */
  blobOffset: number[];
  blobLength: number[];
  /** byte range of the block's line in the edition's blocks.jsonl */
  byteOffset: number[];
  byteLength: number[];
};

export type Postings = {
  /** surface index -> first pair index; length = surfaces + 1 */
  offsets: Uint32Array;
  /** flat (unit, position) pairs, grouped by surface */
  pairs: Uint32Array;
};

export type BuiltEdition = EditionRef & {
  text: string;
  /** Encoded JSON lines (each ending "\n"), one per unit of this edition. */
  blockLines: Uint8Array[];
  /** (surface index, char offset into text) pairs. */
  tokens: Uint32Array;
};

export type Artefacts = {
  manifest: Manifest;
  vocab: Vocab;
  units: UnitTable;
  postings: Postings;
  editions: BuiltEdition[];
};

/** Everything the server holds in memory to answer searches. */
export type ServeArtefacts = {
  dir: string;
  manifest: Manifest;
  vocab: Vocab;
  units: UnitTable;
  postings: Postings;
  /** norm index -> surface indices (derived from vocab at load) */
  normSurfaces: number[][];
};

/* ------------------------------- build ------------------------------- */

/** Visit every block of every edition, under the work that owns its text. */
const eachUnit = (
  catalog: Catalog,
  visit: (
    work: Work,
    edition: Edition,
    sectionPath: string[],
    sectionTitle: string,
    block: Block,
  ) => void,
): void => {
  const owns = (work: Work, doc: MarkitDocument): boolean => {
    const source = catalog.sources.get(doc);
    return source === undefined || source.startsWith(work.dir + "/") ||
      source === work.dir;
  };
  for (const author of catalog.authors) {
    for (const work of author.works) {
      for (const edition of work.editions) {
        if (!owns(work, edition.document)) continue;
        const visitSections = (
          doc: MarkitDocument,
          path: string[],
        ): void => {
          for (const child of doc.children) {
            // Children whose text belongs to another work (composite
            // editions) are indexed under their own work instead.
            if (!owns(work, child)) continue;
            const childPath = [...path, childSlug(child, doc)];
            const title = typeof child.metadata?.title === "string"
              ? child.metadata.title
              : lastSegment(child.id);
            for (const block of child.blocks) {
              visit(work, edition, childPath, title, block);
            }
            visitSections(child, childPath);
          }
        };
        for (const block of edition.document.blocks) {
          visit(work, edition, [], edition.title, block);
        }
        visitSections(edition.document, []);
      }
    }
  }
};

export const buildArtefacts = (
  catalog: Catalog,
  warnings: string[],
  corpus: CorpusScan,
): Artefacts => {
  const encoder = new TextEncoder();

  // Every edition, in catalog order, with display names denormalised so
  // that search responses need no other source.
  const editionRefs: EditionRef[] = [];
  const editionIndex = new Map<string, number>();
  for (const author of catalog.authors) {
    for (const work of author.works) {
      for (const edition of work.editions) {
        editionIndex.set(
          `${author.slug}/${work.slug}/${edition.slug}`,
          editionRefs.length,
        );
        editionRefs.push({
          author: author.slug,
          authorName: author.surname,
          work: work.slug,
          workBreadcrumb: work.breadcrumb,
          edition: edition.slug,
        });
      }
    }
  }

  // Interim, insertion-ordered vocabulary; remapped to sorted ids below.
  const tempIds = new Map<string, number>();
  const tempPostings: number[][] = [];
  const tempCf: number[] = [];
  const tempDf: number[] = [];
  const tempLastUnit: number[] = [];

  const units: UnitTable = {
    edition: [],
    sectionPath: [],
    sectionTitle: [],
    blockId: [],
    isTitle: [],
    tokenCount: [],
    blobOffset: [],
    blobLength: [],
    byteOffset: [],
    byteLength: [],
  };

  type EditionAccumulator = {
    ref: EditionRef;
    text: string;
    blockLines: Uint8Array[];
    bytes: number;
    tokens: number[]; // (tempId, charOffset) pairs
  };
  const accumulators = new Map<number, EditionAccumulator>();
  let totalTokens = 0;

  eachUnit(catalog, (work, edition, sectionPath, sectionTitle, block) => {
    const editionIdx = editionIndex.get(
      `${work.authorSlug}/${work.slug}/${edition.slug}`,
    )!;
    let acc = accumulators.get(editionIdx);
    if (acc === undefined) {
      acc = {
        ref: editionRefs[editionIdx],
        text: "",
        blockLines: [],
        bytes: 0,
        tokens: [],
      };
      accumulators.set(editionIdx, acc);
    }

    const unitIndex = units.edition.length;
    const text = blockText(block);
    const line = encoder.encode(JSON.stringify(block) + "\n");
    const spans = tokenize(text);

    units.edition.push(editionIdx);
    units.sectionPath.push(sectionPath.join("/"));
    units.sectionTitle.push(sectionTitle);
    units.blockId.push(lastSegment(block.id));
    units.isTitle.push(
      block.type === "title" || block.type === "subtitle" ? 1 : 0,
    );
    units.tokenCount.push(spans.length);
    units.blobOffset.push(acc.text.length);
    units.blobLength.push(text.length);
    units.byteOffset.push(acc.bytes);
    units.byteLength.push(line.length - 1); // the line minus its "\n"

    for (let position = 0; position < spans.length; position++) {
      const span = spans[position];
      let tempId = tempIds.get(span.surface);
      if (tempId === undefined) {
        tempId = tempIds.size;
        tempIds.set(span.surface, tempId);
        tempPostings.push([]);
        tempCf.push(0);
        tempDf.push(0);
        tempLastUnit.push(-1);
      }
      tempPostings[tempId].push(unitIndex, position);
      tempCf[tempId]++;
      if (tempLastUnit[tempId] !== unitIndex) {
        tempDf[tempId]++;
        tempLastUnit[tempId] = unitIndex;
      }
      acc.tokens.push(tempId, units.blobOffset[unitIndex] + span.start);
    }
    totalTokens += spans.length;

    acc.text += text + "\n";
    acc.blockLines.push(line);
    acc.bytes += line.length;
  });

  // Final, sorted vocabulary; temp ids -> sorted surface ids.
  const surfaces = [...tempIds.keys()].sort();
  const surfaceId = new Map(surfaces.map((s, i) => [s, i]));
  const tempToFinal = new Uint32Array(tempIds.size);
  for (const [surface, tempId] of tempIds) {
    tempToFinal[tempId] = surfaceId.get(surface)!;
  }
  const norms = [...new Set(surfaces.map(normalizeSurface))].sort();
  const normId = new Map(norms.map((n, i) => [n, i]));
  const vocab: Vocab = {
    surfaces,
    surfaceNorm: surfaces.map((s) => normId.get(normalizeSurface(s))!),
    df: new Array(surfaces.length),
    cf: new Array(surfaces.length),
    norms,
    normLemma: norms.map((_, i) => i),
  };
  for (const [surface, tempId] of tempIds) {
    const id = surfaceId.get(surface)!;
    vocab.df[id] = tempDf[tempId];
    vocab.cf[id] = tempCf[tempId];
  }

  // Pack postings grouped by final surface id.
  const offsets = new Uint32Array(surfaces.length + 1);
  let totalPairs = 0;
  for (let id = 0; id < surfaces.length; id++) {
    offsets[id] = totalPairs;
    totalPairs += tempPostings[tempIds.get(surfaces[id])!].length / 2;
  }
  offsets[surfaces.length] = totalPairs;
  const pairs = new Uint32Array(totalPairs * 2);
  for (let id = 0; id < surfaces.length; id++) {
    pairs.set(tempPostings[tempIds.get(surfaces[id])!], offsets[id] * 2);
  }

  const editions: BuiltEdition[] = [...accumulators.values()].map((acc) => {
    const tokens = new Uint32Array(acc.tokens.length);
    for (let i = 0; i < acc.tokens.length; i += 2) {
      tokens[i] = tempToFinal[acc.tokens[i]];
      tokens[i + 1] = acc.tokens[i + 1];
    }
    return { ...acc.ref, text: acc.text, blockLines: acc.blockLines, tokens };
  });

  const works = catalog.authors.reduce((n, a) => n + a.works.length, 0);
  return {
    manifest: {
      pipelineVersion: PIPELINE_VERSION,
      builtAt: new Date().toISOString(),
      corpus,
      stats: {
        authors: catalog.authors.length,
        works,
        editions: editionRefs.length,
        units: units.edition.length,
        tokens: totalTokens,
        surfaces: surfaces.length,
        norms: norms.length,
      },
      editionSlugs: [...new Set(editionRefs.map((e) => e.edition))].sort(),
      editions: editionRefs,
      warnings,
    },
    vocab,
    units,
    postings: { offsets, pairs },
    editions,
  };
};

/* ------------------------------ write ------------------------------- */

const editionDir = (ref: EditionRef): string =>
  `editions/${ref.author}/${ref.work}/${ref.edition}`;

const concat = (parts: Uint8Array[], bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const asBytes = (array: Uint32Array): Uint8Array =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

/**
 * Write artefacts to `dir`, replacing what was there. Refuses to clear a
 * directory that doesn't look like an artefacts directory. The manifest is
 * written last, so a directory with a manifest is a complete build.
 */
export const writeArtefacts = async (
  dir: string,
  artefacts: Artefacts,
): Promise<void> => {
  let existing: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) existing.push(entry.name);
  } catch {
    existing = [];
  }
  if (existing.length > 0) {
    if (!existing.includes("manifest.json")) {
      throw new Error(
        `${dir} is not empty and has no manifest.json; refusing to replace it`,
      );
    }
    await Deno.remove(dir, { recursive: true });
  }
  await Deno.mkdir(dir, { recursive: true });

  for (const edition of artefacts.editions) {
    const subdir = `${dir}/${editionDir(edition)}`;
    await Deno.mkdir(subdir, { recursive: true });
    const bytes = edition.blockLines.reduce((n, l) => n + l.length, 0);
    await Deno.writeFile(
      `${subdir}/blocks.jsonl`,
      concat(edition.blockLines, bytes),
    );
    await Deno.writeTextFile(`${subdir}/text.txt`, edition.text);
    await Deno.writeFile(`${subdir}/tokens.bin`, asBytes(edition.tokens));
  }
  await Deno.writeFile(
    `${dir}/postings.bin`,
    concat(
      [asBytes(artefacts.postings.offsets), asBytes(artefacts.postings.pairs)],
      artefacts.postings.offsets.byteLength +
        artefacts.postings.pairs.byteLength,
    ),
  );
  await Deno.writeTextFile(
    `${dir}/vocab.json`,
    JSON.stringify(artefacts.vocab),
  );
  await Deno.writeTextFile(
    `${dir}/units.json`,
    JSON.stringify(artefacts.units),
  );
  await Deno.writeTextFile(
    `${dir}/manifest.json`,
    JSON.stringify(artefacts.manifest, null, 2),
  );
};

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
  const vocab = JSON.parse(
    await Deno.readTextFile(`${dir}/vocab.json`),
  ) as Vocab;
  const units = JSON.parse(
    await Deno.readTextFile(`${dir}/units.json`),
  ) as UnitTable;
  const bin = await Deno.readFile(`${dir}/postings.bin`);
  const words = new Uint32Array(bin.buffer, bin.byteOffset, bin.length / 4);
  const split = vocab.surfaces.length + 1;
  const postings: Postings = {
    offsets: words.subarray(0, split),
    pairs: words.subarray(split),
  };
  const normSurfaces: number[][] = vocab.norms.map(() => []);
  for (let id = 0; id < vocab.surfaceNorm.length; id++) {
    normSurfaces[vocab.surfaceNorm[id]].push(id);
  }
  return { dir, manifest, vocab, units, postings, normSurfaces };
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

/* ----------------------------- freshness ----------------------------- */

/** Fingerprint the corpus: .mit file count and latest modification time. */
export const scanCorpus = async (corpusDir: string): Promise<CorpusScan> => {
  let files = 0;
  let modified = 0;
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile && entry.name.endsWith(".mit")) {
        files++;
        const info = await Deno.stat(path);
        modified = Math.max(modified, info.mtime?.getTime() ?? 0);
      }
    }
  };
  await walk(corpusDir);
  return { files, modified };
};

/**
 * Whether the artefacts in `dir` were built by this pipeline version from
 * a corpus matching `scan`.
 */
export const artefactsFresh = async (
  dir: string,
  scan: CorpusScan,
): Promise<boolean> => {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(`${dir}/manifest.json`),
    ) as Manifest;
    return manifest.pipelineVersion === PIPELINE_VERSION &&
      manifest.corpus.files === scan.files &&
      manifest.corpus.modified === scan.modified;
  } catch {
    return false;
  }
};
