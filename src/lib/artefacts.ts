/**
 * The on-disk artefact format: the types describing every derived artefact, the
 * pipeline version that stamps them, and the corpus fingerprint used to tell
 * fresh artefacts from stale. The builder (builder.ts) writes this format and
 * the store (store.ts) reads it; this module is the contract between them and
 * imports neither.
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
 *                    collection frequencies, canonical spellings, form buckets
 *                    and citation-form lemmas
 *   units.json       one row per block (columnar): location, token count,
 *                    offsets into the per-edition text and block files
 *   postings.bin     inverted index over the edited reading text: per surface
 *                    type, (unit, position) pairs as little-endian Uint32. The
 *                    position word's high bit (CAP_BIT) flags an occurrence
 *                    whose first letter was a capital, so a case-sensitive
 *                    search can filter postings without re-reading the text
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
 * The serve-time loader (store.ts) reads only the manifest, catalog, vocab,
 * units, and postings (tens of MB); block content is fetched from blocks.jsonl
 * on demand (by byte range per search hit, or a whole edition at a time,
 * cached, for the text and compare routes), and the text blobs and token
 * streams are not loaded at all (they exist for future corpus analysis and for
 * rebuilding the index quickly).
 */

import type { AuthorMeta, EditionMeta, WorkMeta } from "../types.ts";
import { EXTRACTION_VERSION } from "./text.ts";
import { TOKENIZER_VERSION } from "./tokenize.ts";

/** Bump when the Vocab schema changes (invalidates built artefacts). */
export const VOCAB_VERSION = 2;
export const PIPELINE_VERSION =
  `x${EXTRACTION_VERSION}.t${TOKENIZER_VERSION}.v${VOCAB_VERSION}`;

/**
 * A posting's position word is `position | (capital ? CAP_BIT : 0)`: the low
 * 31 bits are the token's ordinal within its unit, the high bit marks an
 * occurrence whose first letter was a capital (for case-sensitive search).
 * Token ordinals never approach 2^31, so the bit is always free.
 */
export const CAP_BIT = 0x80000000;
export const POSITION_MASK = 0x7fffffff;

/** An edition's subdirectory under the artefacts root (its on-disk location). */
export const editionDir = (ref: EditionRef): string =>
  `editions/${ref.author}/${ref.work}/${ref.edition}`;

/* ------------------------------- types ------------------------------- */

export type EditionRef = {
  author: string;
  authorName: string; // surname, for display
  work: string;
  workBreadcrumb: string;
  edition: string; // a year slug
  /** Whether this is the work's canonical edition (the default search scope). */
  canonical: boolean;
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
    spellings: number;
    forms: number;
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
 * The type table, with three nested levels per surface. Surface forms are the
 * distinct case-folded spellings in the corpus, lexicographically sorted (so
 * prefix queries can binary search). Each surface maps to:
 *
 *  - a canonical SPELLING (orthography normalised, inflection preserved:
 *    "encrease" → "increase", "encreasing" → "increasing") — the
 *    spelling-tolerant search bucket;
 *  - a FORM bucket (inflections collapsed: "increasing" → "increas") — the
 *    inflection-tolerant recall bucket, a Porter stem of the spelling for now;
 *  - a citation-form LEMMA string ("causes" → "cause", "imagined" → "imagine"),
 *    always a real word, for frequency aggregation and other statistics.
 *
 * `spellings` and `forms` are the distinct sorted bucket strings; `surfaceX`
 * indexes into them. The lemma is generated by a suffix-stripping heuristic
 * (run on the canonical spelling, checked against the spelling vocabulary),
 * with curated overrides in lib/lemmas.json for suppletive and archaic forms.
 */
export type Vocab = {
  surfaces: string[];
  /** surface index -> index into spellings */
  surfaceSpelling: number[];
  /** surface index -> index into forms */
  surfaceForm: number[];
  /** number of units containing each surface */
  df: number[];
  /** total occurrences of each surface */
  cf: number[];
  /** distinct canonical spellings, sorted */
  spellings: string[];
  /** distinct form buckets, sorted */
  forms: string[];
  /** surface index -> citation-form lemma string (always a real word) */
  surfaceLemma: string[];
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
  /** flat (unit, position) pairs, grouped by surface; position carries CAP_BIT */
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
  /** spelling index -> surface indices (derived from vocab at load) */
  spellingSurfaces: number[][];
  /** form index -> surface indices (derived from vocab at load) */
  formSurfaces: number[][];
  /** edition index -> its unit indices, in blocks.jsonl line order */
  editionUnits: number[][];
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
