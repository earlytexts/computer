/**
 * The build pipeline: derived artefacts built from the corpus, written to
 * disk (gitignored), and loaded by the server.
 *
 * Layout of the artefacts directory:
 *
 *   manifest.json    pipeline version, corpus fingerprint, edition list,
 *                    stats, build warnings
 *   catalog.json     the Author -> Work -> Edition metadata tree, and per
 *                    edition a section skeleton (the composed section tree
 *                    with titles/breadcrumbs/imported flags) whose nodes carry
 *                    the unit indices of their blocks, not the blocks; this is
 *                    what serves the text and compare routes
 *   vocab.json       the type table: distinct surface forms with document/
 *                    collection frequencies, normalised forms, lemma slot
 *   units.json       one row per block (columnar): location, token count,
 *                    offsets into the per-edition text and block files
 *   postings.bin     inverted index over the edited reading text: per surface
 *                    type, (unit, position) pairs as little-endian Uint32
 *   postings-original.bin
 *                    overlay index (same format/vocab) for searching the
 *                    original text: only the units that carry editorial
 *                    markup, with their original-version token positions
 *   overlay.json     { affectedUnits }: the units the overlay covers, so an
 *                    original search reads them from the overlay instead of
 *                    the (edited) primary
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
 * The serve-time loader reads only the manifest, catalog, vocab, units, and
 * postings (tens of MB); block content is fetched from blocks.jsonl on demand
 * (by byte range per search hit, or a whole edition at a time, cached, for the
 * text and compare routes), and the text blobs and token streams are not
 * loaded at all (they exist for future corpus analysis and for rebuilding the
 * index quickly).
 */

import type { Block, MarkitDocument } from "@earlytexts/markit";
import {
  type Author,
  type Catalog,
  childSlug,
  type Edition,
  lastSegment,
  type Section,
  sectionTree,
  type Work,
} from "./catalog.ts";
import type { AuthorMeta, EditionMeta, WorkMeta } from "../types.ts";
import { blockText, EXTRACTION_VERSION, hasEditorial } from "./text.ts";
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

/* ------------------------------ catalog ------------------------------ */

/**
 * One node of an edition's section skeleton: a section's place and metadata,
 * plus the unit indices of its own blocks (in reading order). Block content
 * is not stored here — it is read from blocks.jsonl on demand. Borrowed
 * children (composite editions) resolve transparently: every block has one
 * unit, under the edition that owns its text, so a unit index addresses the
 * right blocks.jsonl wherever the section appears.
 */
export type SkeletonSection = {
  slug: string;
  path: string[];
  title: string;
  breadcrumb: string;
  imported: boolean;
  /** Unit indices of this section's own blocks, in order. */
  units: number[];
  children: SkeletonSection[];
};

export type EditionEntry = {
  meta: EditionMeta;
  /** Unit indices of the edition's own (title) blocks. */
  units: number[];
  sections: SkeletonSection[];
};

export type WorkEntry = {
  meta: WorkMeta;
  editions: EditionEntry[];
};

export type AuthorEntry = {
  meta: AuthorMeta;
  works: WorkEntry[];
};

/** The metadata tree and per-edition skeletons; serves text and compare. */
export type CatalogArtefact = {
  authors: AuthorEntry[];
  /** Distinct edition slugs across the catalog (for filter UIs). */
  editionSlugs: string[];
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
  catalog: CatalogArtefact;
  vocab: Vocab;
  units: UnitTable;
  postings: Postings;
  /** Original-text overlay for the units in `affectedUnits`. */
  overlayPostings: Postings;
  /** Unit indices that carry editorial markup, ascending. */
  affectedUnits: number[];
  editions: BuiltEdition[];
};

/** Everything the server holds in memory to answer requests. */
export type ServeArtefacts = {
  dir: string;
  manifest: Manifest;
  catalog: CatalogArtefact;
  vocab: Vocab;
  units: UnitTable;
  postings: Postings;
  /** Original-text overlay (see Artefacts); empty when nothing is edited. */
  overlayPostings: Postings;
  /** Units the overlay covers — read from it, not `postings`, for original. */
  affectedUnits: Set<number>;
  /** norm index -> surface indices (derived from vocab at load) */
  normSurfaces: number[][];
  /** edition index -> its unit indices, in blocks.jsonl line order */
  editionUnits: number[][];
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

const authorMeta = (author: Author): AuthorMeta => ({
  slug: author.slug,
  forename: author.forename,
  surname: author.surname,
  title: author.title,
  birth: author.birth,
  death: author.death,
  published: author.published,
  nationality: author.nationality,
  sex: author.sex,
});

const editionMeta = (edition: Edition): EditionMeta => ({
  authorSlug: edition.authorSlug,
  workSlug: edition.workSlug,
  slug: edition.slug,
  isMain: edition.isMain,
  title: edition.title,
  breadcrumb: edition.breadcrumb,
  imported: edition.imported,
  published: edition.published,
  copytext: edition.copytext,
  sourceUrl: edition.sourceUrl,
  sourceDesc: edition.sourceDesc,
});

const workMeta = (work: Work): WorkMeta => ({
  authorSlug: work.authorSlug,
  slug: work.slug,
  title: work.title,
  breadcrumb: work.breadcrumb,
  imported: work.imported,
  published: work.published,
  editions: work.editions.map(editionMeta),
});

/**
 * Turn a section (from the composed section tree) into a skeleton node,
 * looking up each of its blocks' unit indices. A block with no unit (text
 * unreachable from any owned edition — should not happen) is dropped.
 */
const skeletonSection = (
  section: Section,
  blockUnit: Map<Block, number>,
): SkeletonSection => ({
  slug: section.slug,
  path: section.path,
  title: section.title,
  breadcrumb: section.breadcrumb,
  imported: section.imported,
  units: section.doc.blocks
    .map((block) => blockUnit.get(block))
    .filter((unit): unit is number => unit !== undefined),
  children: section.children.map((child) => skeletonSection(child, blockUnit)),
});

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

  // Interim, insertion-ordered vocabulary; remapped to sorted ids below. The
  // vocabulary is the union of the edited and original streams; df/cf count
  // occurrences across both (so original-only spellings are still coherent).
  const tempIds = new Map<string, number>();
  const tempPostings: number[][] = []; // edited reading text (every unit)
  const overlayPostings: number[][] = []; // original text (edited units only)
  const tempCf: number[] = [];
  const tempDf: number[] = [];
  const tempLastUnit: number[] = [];
  // Units carrying editorial markup, in ascending order (eachUnit visits in
  // unit order), whose original text lives in the overlay.
  const affectedUnits: number[] = [];

  /** Find or create the interim id for a surface, parallel arrays in step. */
  const intern = (surface: string): number => {
    let tempId = tempIds.get(surface);
    if (tempId === undefined) {
      tempId = tempIds.size;
      tempIds.set(surface, tempId);
      tempPostings.push([]);
      overlayPostings.push([]);
      tempCf.push(0);
      tempDf.push(0);
      tempLastUnit.push(-1);
    }
    return tempId;
  };

  /** Record one occurrence of a surface in a unit: postings, cf, and df. */
  const record = (
    postings: number[][],
    surface: string,
    unitIndex: number,
    position: number,
  ): number => {
    const tempId = intern(surface);
    postings[tempId].push(unitIndex, position);
    tempCf[tempId]++;
    if (tempLastUnit[tempId] !== unitIndex) {
      tempDf[tempId]++;
      tempLastUnit[tempId] = unitIndex;
    }
    return tempId;
  };

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

  // Block (by identity) -> its unit index. Composite editions splice the same
  // child block objects into several parents, so this resolves a borrowed
  // section's blocks to the unit under the edition that owns their text.
  const blockUnit = new Map<Block, number>();

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
    blockUnit.set(block, unitIndex);
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
      const tempId = record(tempPostings, span.surface, unitIndex, position);
      acc.tokens.push(tempId, units.blobOffset[unitIndex] + span.start);
    }
    totalTokens += spans.length;

    // Where the block carries editorial markup, index its original text into
    // the overlay too, with original-version token positions, so an original
    // search reads this unit from the overlay instead of the (edited) primary.
    if (hasEditorial(block)) {
      affectedUnits.push(unitIndex);
      const originalSpans = tokenize(blockText(block, "original"));
      for (let position = 0; position < originalSpans.length; position++) {
        record(
          overlayPostings,
          originalSpans[position].surface,
          unitIndex,
          position,
        );
      }
    }

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

  // Pack a (tempId-indexed) postings table grouped by final surface id.
  const packPostings = (source: number[][]): Postings => {
    const offsets = new Uint32Array(surfaces.length + 1);
    let total = 0;
    for (let id = 0; id < surfaces.length; id++) {
      offsets[id] = total;
      total += source[tempIds.get(surfaces[id])!].length / 2;
    }
    offsets[surfaces.length] = total;
    const pairs = new Uint32Array(total * 2);
    for (let id = 0; id < surfaces.length; id++) {
      pairs.set(source[tempIds.get(surfaces[id])!], offsets[id] * 2);
    }
    return { offsets, pairs };
  };
  const postings = packPostings(tempPostings);
  const overlay = packPostings(overlayPostings);

  const editions: BuiltEdition[] = [...accumulators.values()].map((acc) => {
    const tokens = new Uint32Array(acc.tokens.length);
    for (let i = 0; i < acc.tokens.length; i += 2) {
      tokens[i] = tempToFinal[acc.tokens[i]];
      tokens[i + 1] = acc.tokens[i + 1];
    }
    return { ...acc.ref, text: acc.text, blockLines: acc.blockLines, tokens };
  });

  // The metadata tree and per-edition skeletons, built from the composed
  // section trees (which include borrowed children); block content stays in
  // blocks.jsonl and is addressed by the unit indices recorded above.
  const catalogArtefact: CatalogArtefact = {
    authors: catalog.authors.map((author) => ({
      meta: authorMeta(author),
      works: author.works.map((work) => ({
        meta: workMeta(work),
        editions: work.editions.map((edition) => ({
          meta: editionMeta(edition),
          units: edition.document.blocks
            .map((block) => blockUnit.get(block))
            .filter((unit): unit is number => unit !== undefined),
          sections: sectionTree(edition.document)
            .map((section) => skeletonSection(section, blockUnit)),
        })),
      })),
    })),
    editionSlugs: [...new Set(editionRefs.map((e) => e.edition))].sort(),
  };

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
      editionSlugs: catalogArtefact.editionSlugs,
      editions: editionRefs,
      warnings,
    },
    catalog: catalogArtefact,
    vocab,
    units,
    postings,
    overlayPostings: overlay,
    affectedUnits,
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
  const writePostings = (name: string, postings: Postings): Promise<void> =>
    Deno.writeFile(
      `${dir}/${name}`,
      concat(
        [asBytes(postings.offsets), asBytes(postings.pairs)],
        postings.offsets.byteLength + postings.pairs.byteLength,
      ),
    );
  await writePostings("postings.bin", artefacts.postings);
  await writePostings("postings-original.bin", artefacts.overlayPostings);
  await Deno.writeTextFile(
    `${dir}/overlay.json`,
    JSON.stringify({ affectedUnits: artefacts.affectedUnits }),
  );
  await Deno.writeTextFile(
    `${dir}/catalog.json`,
    JSON.stringify(artefacts.catalog),
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
  const normSurfaces: number[][] = vocab.norms.map(() => []);
  for (let id = 0; id < vocab.surfaceNorm.length; id++) {
    normSurfaces[vocab.surfaceNorm[id]].push(id);
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
    normSurfaces,
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
