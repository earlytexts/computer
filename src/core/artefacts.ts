/**
 * The on-disk artefact format: the types describing every derived artefact, the
 * pipeline version that stamps them, the corpus fingerprint used to tell fresh
 * artefacts from stale, and the codec that turns built artefacts into bytes and
 * back (serializeArtefacts / parseArtefacts). The builder (builder.ts) produces
 * the in-memory Artefacts and the store (store.ts) consumes the ServeArtefacts;
 * this module is the format authority between them, doing no I/O of its own (the
 * io adapter reads and writes the bytes) and importing neither side.
 *
 * Layout of the artefacts directory:
 *
 *   manifest.json    pipeline version, corpus fingerprint, edition list,
 *                    stats, build warnings
 *   catalogue.json     the Author -> Work -> Edition metadata tree, and per
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
 *   dtm.bin          the document-term matrix: one sparse row per (edition,
 *                    section) document of TF-IDF weights over lemma columns, in
 *                    CSR form (row pointers, then column ids, then L2-normalised
 *                    Float32 values). Built here as the substrate for the vector
 *                    routes (similarity, topics); like tokens.bin it is read
 *                    lazily by those routes, not loaded at boot
 *   dtm.json         the DTM's row labels (each document's edition index and
 *                    section path), its column labels (the lemmas), and the
 *                    non-zero count, so dtm.bin can be sliced back into arrays
 *   topics.bin       the topic model's document-topic matrix: one dense row per
 *                    DTM document of its mix over the K topics (Float32, each row
 *                    summing to 1, or 0 for an empty document). Trained at build
 *                    time (NMF over the DTM); read lazily by the topic routes
 *   topics.json      the topic model's metadata: the topic count K, the document
 *                    row labels (same order as dtm.json's), and per topic its
 *                    highest-weight lemmas (the topic-term distribution)
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
 * parseArtefacts reads only the manifest, catalogue, vocab, units, and postings
 * (tens of MB) into the in-memory ServeArtefacts; block content is fetched from
 * blocks.jsonl on demand through a BlockReader (by byte range per search hit,
 * or a whole edition at a time, cached, for the text and compare routes), and
 * the text blobs and token streams are not read at all (they exist for future
 * corpus analysis and for rebuilding the index quickly).
 */

import type { AuthorMeta, EditionMeta, WorkMeta } from "../types.ts";
import { EXTRACTION_VERSION, TOKENIZER_VERSION } from "./text/mod.ts";

/** Bump when the Vocab schema changes (invalidates built artefacts). */
export const VOCAB_VERSION = 2;
/**
 * Bump when the *set* of artefacts changes without a vocab/extraction/tokenizer
 * change — adding, removing, or reshaping a derived file — so that an artefacts
 * directory built before the change is treated as stale and rebuilt. The DTM
 * (dtm.bin/dtm.json) landing took this to 1; the topic model (topics.bin/
 * topics.json) to 2.
 */
export const ARTEFACT_VERSION = 2;
export const PIPELINE_VERSION =
  `x${EXTRACTION_VERSION}.t${TOKENIZER_VERSION}.v${VOCAB_VERSION}.a${ARTEFACT_VERSION}`;

/**
 * A posting's position word is `position | (capital ? CAP_BIT : 0)`: the low
 * 31 bits are the token's ordinal within its unit, the high bit marks an
 * occurrence whose first letter was a capital (for case-sensitive search).
 * Token ordinals never approach 2^31, so the bit is always free.
 */
export const CAP_BIT = 0x80000000;
export const POSITION_MASK = 0x7fffffff;

/** An edition's subdirectory under the artefacts root (its on-disk location).
 * Keyed by the primary (host) author so a co-authored work has one location. */
export const editionDir = (ref: EditionRef): string =>
  `editions/${ref.authors[0]}/${ref.work}/${ref.edition}`;

/**
 * The fixed-name artefact files (everything but the per-edition subdirectories).
 * Owned here so the format — names and codec alike — has one authority; the io
 * adapter reads and writes whatever these name without knowing the layout.
 */
export const ARTEFACT_FILES = {
  manifest: "manifest.json",
  catalogue: "catalogue.json",
  vocab: "vocab.json",
  units: "units.json",
  postings: "postings.bin",
  postingsOriginal: "postings-original.bin",
  overlay: "overlay.json",
} as const;

/**
 * The DTM artefact files. Kept out of ARTEFACT_FILES on purpose: those are the
 * tables read into memory at boot (readArtefacts/parseArtefacts), whereas the
 * DTM is written at build time and read lazily by the vector routes (item 3/4),
 * exactly as tokens.bin is. The codec (de)serializes it through parseDtm.
 */
export const DTM_BIN = "dtm.bin";
export const DTM_JSON = "dtm.json";

/**
 * The topic-model artefact files, kept out of ARTEFACT_FILES for the same reason
 * the DTM is: they are trained at build time and read lazily by the topic routes
 * (item 4), not loaded into memory at boot. The codec (de)serializes them through
 * parseTopics.
 */
export const TOPICS_BIN = "topics.bin";
export const TOPICS_JSON = "topics.json";

/** The serialized artefacts: a relative path -> bytes map (see serializeArtefacts). */
export type ArtefactFiles = Map<string, Uint8Array>;

/* ------------------------------- types ------------------------------- */

export type EditionRef = {
  /** The work's author slugs, in title order — the people who wrote it. */
  authors: string[];
  authorNames: string[]; // surnames, parallel to `authors`, for display
  /** The work's identity slug for paths/URLs (joint, e.g. "astell-norris", for
   * a co-authored work). Not itself an author. */
  hostSlug: string;
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
  /** Distinct edition slugs across the catalogue (for filter UIs). */
  editionSlugs: string[];
  /** Every edition, in catalogue order; units.edition indexes into this. */
  editions: EditionRef[];
  warnings: string[];
};

/* ------------------------------ catalogue ------------------------------ */

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
  /** Author slugs of this section (cascaded), for per-section attribution. */
  authors: string[];
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
export type CatalogueArtefact = {
  authors: AuthorEntry[];
  /** Distinct edition slugs across the catalogue (for filter UIs). */
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

/**
 * One row of the DTM: a document is all the units sharing an (edition, section)
 * pair, so a row addresses a section as it appears in one edition. `edition`
 * indexes into manifest.editions; `sectionPath` is the unit's sectionPath ("" for
 * an edition's own title blocks), matching UnitTable.sectionPath.
 */
export type DocRef = {
  edition: number;
  sectionPath: string;
};

/**
 * The document-term matrix in compressed sparse row (CSR) form: rows are the
 * `docs`, columns the `lemmas`, values L2-normalised TF-IDF weights (so cosine
 * similarity between two rows is their dot product). `rowPtr` has length
 * docs+1; row d's entries are `cols[rowPtr[d]..rowPtr[d+1]]` with weights
 * `vals[...]`, columns ascending. The substrate for items 3 (similarity) and 4
 * (topics); no route reads it yet.
 */
export type Dtm = {
  docs: DocRef[];
  /** Column labels: the citation-form lemmas present in the edited text. */
  lemmas: string[];
  /** Row offsets into cols/vals; length docs.length + 1. */
  rowPtr: Uint32Array;
  /** Column (lemma) id of each non-zero, grouped by row, ascending within a row. */
  cols: Uint32Array;
  /** L2-normalised TF-IDF weight of each non-zero, parallel to cols. */
  vals: Float32Array;
};

/** One lemma of a topic's term distribution: the lemma and its weight in [0, 1]. */
export type TopicTerm = {
  lemma: string;
  /** The lemma's share of the topic's mass (the normalised NMF factor). */
  weight: number;
};

/**
 * An unsupervised topic model over the DTM (item 4 of the roadmap), trained by
 * NMF: the document-term matrix V factors as V ≈ W·H, with W the document-topic
 * matrix (`mix`, one row per DTM document, summing to 1) and H the topic-term
 * matrix (summarised here as each topic's highest-weight `terms`). `docs` runs
 * parallel to the DTM's docs (same order), so a document's mix and its DTM row
 * share an index. No factor is exposed raw on the wire — the routes report topic
 * labels, top terms, and per-target mixes, the same opacity as the vectors.
 */
export type Topics = {
  /** Number of topics K. */
  k: number;
  /** Row labels of `mix`, identical in order to the DTM's docs. */
  docs: DocRef[];
  /** Per topic, its highest-weight lemmas (descending); length k. */
  terms: TopicTerm[][];
  /**
   * Document-topic mixes, row-major `docs.length` × k: row d's weight for topic
   * t is `mix[d * k + t]`. Each row sums to 1 (a mix over topics), or to 0 for a
   * document with no indexed text.
   */
  mix: Float32Array;
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
  catalogue: CatalogueArtefact;
  vocab: Vocab;
  units: UnitTable;
  postings: Postings;
  /** Original-text overlay for the units in `affectedUnits`. */
  overlayPostings: Postings;
  /** Unit indices that carry editorial markup, ascending. */
  affectedUnits: number[];
  editions: BuiltEdition[];
  /** Document-term matrix (TF-IDF), the substrate for similarity and topics. */
  dtm: Dtm;
  /** Topic model (NMF over the DTM): topic-term and document-topic factors. */
  topics: Topics;
};

/** Everything the server holds in memory to answer requests. */
export type ServeArtefacts = {
  manifest: Manifest;
  catalogue: CatalogueArtefact;
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

/**
 * Whether a manifest describes artefacts built by this pipeline version from a
 * corpus matching `scan`. Pure: the manifest read (and the "no manifest" case)
 * live in the io adapter, which passes what it found here for the decision.
 */
export const isFresh = (manifest: Manifest, scan: CorpusScan): boolean =>
  manifest.pipelineVersion === PIPELINE_VERSION &&
  manifest.corpus.files === scan.files &&
  manifest.corpus.modified === scan.modified;

/* ------------------------------- codec ------------------------------- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const asBytes = (array: Uint32Array | Float32Array): Uint8Array =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

const postingsBytes = (postings: Postings): Uint8Array =>
  concat([asBytes(postings.offsets), asBytes(postings.pairs)]);

/**
 * Serialize built artefacts to a relative-path -> bytes map: the in-memory
 * tables become exactly the bytes the io adapter writes to disk, with no
 * filesystem concerns here. The per-edition files live under editionDir(); the
 * fixed tables under ARTEFACT_FILES. The inverse is parseArtefacts.
 */
export const serializeArtefacts = (artefacts: Artefacts): ArtefactFiles => {
  const files: ArtefactFiles = new Map();
  for (const edition of artefacts.editions) {
    const subdir = editionDir(edition);
    files.set(`${subdir}/blocks.jsonl`, concat(edition.blockLines));
    files.set(`${subdir}/text.txt`, encoder.encode(edition.text));
    files.set(`${subdir}/tokens.bin`, asBytes(edition.tokens));
  }
  files.set(ARTEFACT_FILES.postings, postingsBytes(artefacts.postings));
  files.set(
    ARTEFACT_FILES.postingsOriginal,
    postingsBytes(artefacts.overlayPostings),
  );
  const json = (value: unknown, pretty = false): Uint8Array =>
    encoder.encode(JSON.stringify(value, null, pretty ? 2 : undefined));
  const { dtm } = artefacts;
  files.set(
    DTM_BIN,
    concat([asBytes(dtm.rowPtr), asBytes(dtm.cols), asBytes(dtm.vals)]),
  );
  files.set(
    DTM_JSON,
    json({ docs: dtm.docs, lemmas: dtm.lemmas, nnz: dtm.cols.length }),
  );
  const { topics } = artefacts;
  files.set(TOPICS_BIN, asBytes(topics.mix));
  files.set(
    TOPICS_JSON,
    json({ k: topics.k, docs: topics.docs, terms: topics.terms }),
  );
  files.set(
    ARTEFACT_FILES.overlay,
    json({ affectedUnits: artefacts.affectedUnits }),
  );
  files.set(ARTEFACT_FILES.catalogue, json(artefacts.catalogue));
  files.set(ARTEFACT_FILES.vocab, json(artefacts.vocab));
  files.set(ARTEFACT_FILES.units, json(artefacts.units));
  files.set(ARTEFACT_FILES.manifest, json(artefacts.manifest, true));
  return files;
};

const readPostings = (bytes: Uint8Array, split: number): Postings => {
  const words = new Uint32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.length / 4,
  );
  return { offsets: words.subarray(0, split), pairs: words.subarray(split) };
};

/**
 * Parse the fixed artefact tables into the in-memory state the server holds,
 * deriving the surface/spelling/form and edition->unit indices. Block content
 * is not read here — it is fetched lazily through a BlockReader at serve time.
 * The inverse of serializeArtefacts; throws on a pipeline-version mismatch.
 */
export const parseArtefacts = (files: ArtefactFiles): ServeArtefacts => {
  const text = (name: string): string => decoder.decode(files.get(name));
  const manifest = JSON.parse(text(ARTEFACT_FILES.manifest)) as Manifest;
  if (manifest.pipelineVersion !== PIPELINE_VERSION) {
    throw new Error(
      `artefacts were built by pipeline ${manifest.pipelineVersion}; ` +
        `this is ${PIPELINE_VERSION}`,
    );
  }
  const catalogue = JSON.parse(
    text(ARTEFACT_FILES.catalogue),
  ) as CatalogueArtefact;
  const vocab = JSON.parse(text(ARTEFACT_FILES.vocab)) as Vocab;
  const units = JSON.parse(text(ARTEFACT_FILES.units)) as UnitTable;
  const split = vocab.surfaces.length + 1;
  const postings = readPostings(files.get(ARTEFACT_FILES.postings)!, split);
  const overlayPostings = readPostings(
    files.get(ARTEFACT_FILES.postingsOriginal)!,
    split,
  );
  const overlay = JSON.parse(text(ARTEFACT_FILES.overlay)) as {
    affectedUnits: number[];
  };
  const spellingSurfaces: number[][] = vocab.spellings.map(() => []);
  for (let id = 0; id < vocab.surfaceSpelling.length; id++) {
    spellingSurfaces[vocab.surfaceSpelling[id]].push(id);
  }
  const formSurfaces: number[][] = vocab.forms.map(() => []);
  for (let id = 0; id < vocab.surfaceForm.length; id++) {
    formSurfaces[vocab.surfaceForm[id]].push(id);
  }
  // Units are written to each edition's blocks.jsonl in units.edition order,
  // so this groups them in blocks.jsonl line order.
  const editionUnits: number[][] = manifest.editions.map(() => []);
  for (let unit = 0; unit < units.edition.length; unit++) {
    editionUnits[units.edition[unit]].push(unit);
  }
  return {
    manifest,
    catalogue,
    vocab,
    units,
    postings,
    overlayPostings,
    affectedUnits: new Set(overlay.affectedUnits),
    spellingSurfaces,
    formSurfaces,
    editionUnits,
  };
};

/**
 * Reconstruct the DTM from its two files (the bytes of dtm.json and dtm.bin).
 * The inverse of the DTM half of serializeArtefacts. Read lazily by the vector
 * routes (similarity, topics) — not by parseArtefacts, which loads only what the
 * search/text routes need. The typed-array views borrow `bin`'s buffer, so it
 * must be 4-byte aligned (a whole-file read is).
 */
export const parseDtm = (json: Uint8Array, bin: Uint8Array): Dtm => {
  const meta = JSON.parse(decoder.decode(json)) as {
    docs: DocRef[];
    lemmas: string[];
    nnz: number;
  };
  const nDocs = meta.docs.length;
  const nnz = meta.nnz;
  const words = new Uint32Array(bin.buffer, bin.byteOffset, nDocs + 1 + nnz);
  return {
    docs: meta.docs,
    lemmas: meta.lemmas,
    rowPtr: words.subarray(0, nDocs + 1),
    cols: words.subarray(nDocs + 1, nDocs + 1 + nnz),
    vals: new Float32Array(
      bin.buffer,
      bin.byteOffset + (nDocs + 1 + nnz) * 4,
      nnz,
    ),
  };
};

/**
 * Reconstruct the topic model from its two files (the bytes of topics.json and
 * topics.bin). The inverse of the topics half of serializeArtefacts. Read lazily
 * by the topic routes, like parseDtm. The Float32 view borrows `bin`'s buffer, so
 * it must be 4-byte aligned (a whole-file read is).
 */
export const parseTopics = (json: Uint8Array, bin: Uint8Array): Topics => {
  const meta = JSON.parse(decoder.decode(json)) as {
    k: number;
    docs: DocRef[];
    terms: TopicTerm[][];
  };
  return {
    k: meta.k,
    docs: meta.docs,
    terms: meta.terms,
    mix: new Float32Array(
      bin.buffer,
      bin.byteOffset,
      meta.docs.length * meta.k,
    ),
  };
};
