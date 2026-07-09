/**
 * Build-time construction of the artefacts: fold the compiled corpus into the
 * in-memory tables (buildArtefacts). Turning those tables into bytes and back
 * is the codec in artefacts.ts (serializeArtefacts / parseArtefacts); the io
 * adapter does the disk writes.
 *
 * The invariant everything rests on: text.txt is exactly the output of
 * blockText over blocks.jsonl, and every offset in tokens.bin/units.json points
 * into it. The pipeline version (extraction + tokenizer) is stamped into the
 * manifest; artefacts from another version are never served.
 */

import type { Block, MarkitDocument } from "@earlytexts/markit";
import { type Overrides, overridesOf } from "@earlytexts/corpus/wire";
import {
  type Author,
  type Catalogue,
  childSlug,
  type Edition,
  lastSegment,
  type Section,
  sectionTree,
  type Work,
} from "./catalogue.ts";
import type { AuthorMeta, EditionMeta, WorkMeta } from "../../types.ts";
import {
  blockText,
  hasEditorial,
  resolveTokenReadings,
  surfaceReadings,
  tokenContexts,
  tokenize,
} from "../text/mod.ts";
import {
  type Artefacts,
  type BuiltEdition,
  CAP_BIT,
  type CatalogueArtefact,
  type CorpusScan,
  type DocRef,
  type Dtm,
  type EditionRef,
  PIPELINE_VERSION,
  type Postings,
  READING_EXEMPT,
  readingOf,
  type SkeletonSection,
  type Topics,
  type TopicTerm,
  type UnitTable,
  type Vocab,
} from "../artefacts.ts";

/* ------------------------------- build ------------------------------- */

/** Whether a token's first character is a capital letter (for CAP_BIT). */
const isCapital = (first: string): boolean =>
  first !== first.toLowerCase() && first === first.toUpperCase();

/** Visit every block of every edition, under the work that owns its text. Each
 * block carries the `[metadata.dictionary]` overrides of its enclosing text,
 * cascaded down the section tree (nearest ancestor wins per surface), so a
 * token's reading can be resolved in its edition's orthographic context. */
const eachUnit = (
  catalogue: Catalogue,
  visit: (
    work: Work,
    edition: Edition,
    sectionPath: string[],
    sectionTitle: string,
    block: Block,
    overrides: Overrides,
  ) => void,
): void => {
  const owns = (work: Work, doc: MarkitDocument): boolean => {
    const source = catalogue.sources.get(doc);
    return source === undefined || source.startsWith(work.dir + "/") ||
      source === work.dir;
  };
  // A co-authored work is listed under each of its authors; index its blocks
  // once (under the host author), or its units would be counted twice.
  const seen = new Set<Work>();
  for (const author of catalogue.authors) {
    for (const work of author.works) {
      if (seen.has(work)) continue;
      seen.add(work);
      for (const edition of work.editions) {
        // An edition's own document always lives in its work's directory; only
        // its borrowed child sections (handled below) can belong elsewhere.
        const visitSections = (
          doc: MarkitDocument,
          path: string[],
          overrides: Overrides,
        ): void => {
          for (const child of doc.children) {
            // Children whose text belongs to another work (composite
            // editions) are indexed under their own work instead.
            if (!owns(work, child)) continue;
            const childPath = [...path, childSlug(child, doc)];
            const title = typeof child.metadata?.title === "string"
              ? child.metadata.title
              : lastSegment(child.id);
            const childOverrides = {
              ...overrides,
              ...overridesOf(child.metadata),
            };
            for (const block of child.blocks) {
              visit(work, edition, childPath, title, block, childOverrides);
            }
            visitSections(child, childPath, childOverrides);
          }
        };
        const editionOverrides = overridesOf(edition.document.metadata);
        for (const block of edition.document.blocks) {
          visit(work, edition, [], edition.title, block, editionOverrides);
        }
        visitSections(edition.document, [], editionOverrides);
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
  firstPublished: author.firstPublished,
  nationality: author.nationality,
  sex: author.sex,
});

const editionMeta = (edition: Edition): EditionMeta => ({
  authorSlugs: edition.authorSlugs,
  workSlug: edition.workSlug,
  slug: edition.slug,
  title: edition.title,
  breadcrumb: edition.breadcrumb,
  imported: edition.imported,
  published: edition.published,
  sourceUrl: edition.sourceUrl,
  sourceDesc: edition.sourceDesc,
});

const workMeta = (work: Work): WorkMeta => ({
  authorSlugs: work.authorSlugs,
  hostSlug: work.hostSlug,
  slug: work.slug,
  title: work.title,
  breadcrumb: work.breadcrumb,
  imported: work.imported,
  firstPublished: work.firstPublished,
  canonicalSlug: work.canonicalSlug,
  standalone: work.standalone,
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
  authors: section.authors,
  units: section.doc.blocks
    .map((block) => blockUnit.get(block))
    .filter((unit): unit is number => unit !== undefined),
  children: section.children.map((child) => skeletonSection(child, blockUnit)),
});

/* -------------------------------- DTM -------------------------------- */

/**
 * Build the document-term matrix from the finished vocabulary, unit table, and
 * (edited) inverted index. A document is all the units sharing an (edition,
 * section) pair — a section as it appears in one edition — so no unit is counted
 * twice even where a composite edition borrows a section (units carry the
 * edition that owns their text). Columns are the citation-form lemmas that occur
 * in the edited text (overlay-only surfaces, which have no edited postings,
 * contribute none), so the matrix is grounded in the text as published, matching
 * how df/cf are counted (see the overlay note in buildArtefacts).
 *
 * Weights are log-normalised term frequency (1 + ln count) times smoothed
 * inverse document frequency (ln((N+1)/(df+1)) + 1), then L2-normalised per row
 * so that cosine similarity between two rows is their dot product. Stored CSR,
 * columns ascending within each row.
 */
export const buildDtm = (
  vocab: Vocab,
  units: UnitTable,
  postings: Postings,
): Dtm => {
  const nUnits = units.edition.length;
  // Map each unit to its (edition, section) document, in first-seen order.
  const docIndex = new Map<string, number>();
  const docs: DocRef[] = [];
  const unitDoc = new Int32Array(nUnits);
  for (let u = 0; u < nUnits; u++) {
    const key = `${units.edition[u]}\t${units.sectionPath[u]}`;
    let doc = docIndex.get(key);
    if (doc === undefined) {
      doc = docs.length;
      docIndex.set(key, doc);
      docs.push({
        edition: units.edition[u],
        sectionPath: units.sectionPath[u],
      });
    }
    unitDoc[u] = doc;
  }
  const nDocs = docs.length;

  // Lemma columns, interned lazily so only lemmas present in the edited text get
  // a column. Sparse per-document counts: doc -> (column -> occurrences). Each
  // occurrence is counted under the lemma(s) of the reading it actually resolved
  // to (its stored per-posting reading), so an edition's overrides and `[w:]`
  // markup steer the statistics; a contraction ('tis) counts under each of its
  // words' lemmas.
  const lemmaIndex = new Map<string, number>();
  const lemmas: string[] = [];
  const counts: Map<number, number>[] = Array.from(
    { length: nDocs },
    () => new Map(),
  );
  const columnOf = (lemma: string): number => {
    let col = lemmaIndex.get(lemma);
    if (col === undefined) {
      col = lemmas.length;
      lemmas.push(lemma);
      lemmaIndex.set(lemma, col);
    }
    return col;
  };
  const { offsets, pairs, readings } = postings;
  for (let id = 0; id < vocab.surfaces.length; id++) {
    if (offsets[id] === offsets[id + 1]) continue; // overlay-only surface
    for (let p = offsets[id]; p < offsets[id + 1]; p++) {
      const m = counts[unitDoc[pairs[p * 2]]];
      for (const word of readingOf(vocab, id, readings[p])) {
        m.set(columnOf(word.lemma), (m.get(columnOf(word.lemma)) ?? 0) + 1);
      }
    }
  }

  // Document frequency per column, then smoothed IDF.
  const docFreq = new Float64Array(lemmas.length);
  for (const m of counts) for (const col of m.keys()) docFreq[col]++;
  const idf = new Float64Array(lemmas.length);
  for (let c = 0; c < lemmas.length; c++) {
    idf[c] = Math.log((nDocs + 1) / (docFreq[c] + 1)) + 1;
  }

  // Emit CSR rows of L2-normalised TF-IDF weights.
  let nnz = 0;
  for (const m of counts) nnz += m.size;
  const rowPtr = new Uint32Array(nDocs + 1);
  const cols = new Uint32Array(nnz);
  const vals = new Float32Array(nnz);
  let at = 0;
  for (let doc = 0; doc < nDocs; doc++) {
    const entries = [...counts[doc]].sort((a, b) => a[0] - b[0]);
    let norm = 0;
    const weights = entries.map(([col, count]) => {
      const w = (1 + Math.log(count)) * idf[col];
      norm += w * w;
      return w;
    });
    const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    for (let k = 0; k < entries.length; k++) {
      cols[at] = entries[k][0];
      vals[at] = weights[k] * inv;
      at++;
    }
    rowPtr[doc + 1] = at;
  }
  return { docs, lemmas, rowPtr, cols, vals };
};

/* ------------------------------ topics ------------------------------- */

/** Number of topics the model learns. */
export const TOPIC_COUNT = 24;
/** Multiplicative-update passes; NMF over a corpus this size stabilises well before. */
const TOPIC_ITERATIONS = 100;
/** Highest-weight lemmas stored per topic (the topic-term distribution we expose). */
const TOPIC_TERMS = 25;
/**
 * Lemmas occurring in more than this fraction of documents are dropped from the
 * topic model's view of the DTM. Such ubiquitous words (the function-word glue:
 * "the", "be", "of") carry no topical signal and, left in, NMF wastes whole
 * topics modelling them. This filters only the topic model's input — the stored
 * DTM, which similarity relies on, keeps every column.
 */
const TOPIC_MAX_DF = 0.5;
/** Fixed seed so the model — and therefore the artefact — is deterministic. */
const TOPIC_SEED = 0x9e3779b9;
/** Floor in the multiplicative updates, to keep factors positive and divisions finite. */
const EPS = 1e-10;

/** A small deterministic PRNG (mulberry32) for reproducible factor initialisation. */
const mulberry32 = (seed: number): () => number => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * The DTM restricted to the columns the topic model trains on: every lemma not
 * present in more than TOPIC_MAX_DF of the documents, with the CSR re-mapped onto
 * the surviving columns. When the cut would leave fewer columns than the model
 * has topics (a tiny corpus), it is skipped and the full DTM returned, so the
 * model always has something to factor.
 */
const topicColumns = (
  dtm: Dtm,
  nDocs: number,
): Pick<Dtm, "lemmas" | "rowPtr" | "cols" | "vals"> => {
  const { lemmas, rowPtr, cols, vals } = dtm;
  const docFreq = new Uint32Array(lemmas.length);
  for (let i = 0; i < cols.length; i++) docFreq[cols[i]]++;
  const maxDf = TOPIC_MAX_DF * nDocs;

  // Surviving columns, in original order; -1 marks a dropped column.
  const remap = new Int32Array(lemmas.length).fill(-1);
  const keptLemmas: string[] = [];
  for (let c = 0; c < lemmas.length; c++) {
    if (docFreq[c] <= maxDf) {
      remap[c] = keptLemmas.length;
      keptLemmas.push(lemmas[c]);
    }
  }
  // Too aggressive for this corpus — keep the whole vocabulary instead.
  if (keptLemmas.length < Math.min(TOPIC_COUNT, nDocs)) {
    return { lemmas, rowPtr, cols, vals };
  }

  // Re-emit the CSR over the kept columns (rows shrink, order preserved).
  const keptRowPtr = new Uint32Array(rowPtr.length);
  const keptCols: number[] = [];
  const keptVals: number[] = [];
  for (let d = 0; d < nDocs; d++) {
    for (let i = rowPtr[d]; i < rowPtr[d + 1]; i++) {
      const c = remap[cols[i]];
      if (c === -1) continue;
      keptCols.push(c);
      keptVals.push(vals[i]);
    }
    keptRowPtr[d + 1] = keptCols.length;
  }
  return {
    lemmas: keptLemmas,
    rowPtr: keptRowPtr,
    cols: Uint32Array.from(keptCols),
    vals: Float32Array.from(keptVals),
  };
};

/**
 * Train a topic model on the document-term matrix by non-negative matrix
 * factorisation (item 4 of the roadmap). NMF is the natural partner to a TF-IDF
 * matrix: it factors V (docs × lemmas) into two non-negative parts, V ≈ W·H, with
 * W the document-topic mix and H the topic-term distribution — both readable as
 * "what each document is about" and "what each topic is about", with none of the
 * raw-count assumptions LDA makes. The factors are found by Lee & Seung's
 * multiplicative updates (minimising ‖V − W·H‖²), which keep every entry
 * non-negative and need no learning rate; a fixed seed and pass count make the
 * result deterministic, so the artefact is reproducible.
 *
 * V is the sparse CSR matrix; W (nDocs × k) and H (k × nLemmas) are dense and
 * row-major. The per-pass cost is O(nnz·k) for the V products plus O((nDocs +
 * nLemmas)·k²) for the dense ones — linear in the corpus, so a build-time step.
 * After training each topic is L1-normalised (its mass pushed from H into W),
 * which fixes NMF's scaling freedom so a document's mix is a genuine proportion;
 * the stored mix is then each W row re-normalised to sum to 1.
 */
export const buildTopics = (dtm: Dtm): Topics => {
  const { docs } = dtm;
  const nDocs = docs.length;
  if (nDocs === 0 || dtm.lemmas.length === 0) {
    // No documents or no vocabulary: there is no model. k = 0 is the contract the
    // topic routes read as "the corpus has no topic model" (see render.ts).
    return { k: 0, docs, terms: [], mix: new Float32Array(0) };
  }

  // Restrict the model's columns to the topical lemmas: drop those in too many
  // documents (function-word glue) by re-mapping the DTM onto the surviving
  // columns. The filter is skipped if it would leave too few columns to model
  // (a tiny corpus), falling back to the full vocabulary.
  const { lemmas, rowPtr, cols, vals } = topicColumns(dtm, nDocs);
  const nTerms = lemmas.length;
  // Never ask for more topics than the data can support (tiny corpora, tests).
  const k = Math.max(1, Math.min(TOPIC_COUNT, nDocs, nTerms));

  const rand = mulberry32(TOPIC_SEED);
  const W = new Float64Array(nDocs * k); // document-topic
  const H = new Float64Array(k * nTerms); // topic-term
  for (let i = 0; i < W.length; i++) W[i] = rand() + EPS;
  for (let i = 0; i < H.length; i++) H[i] = rand() + EPS;

  // Scratch reused across passes: the k×k Gram matrices and the dense numerators.
  const gram = new Float64Array(k * k); // WᵀW or HHᵀ
  const numerH = new Float64Array(k * nTerms);
  const denomH = new Float64Array(k * nTerms);
  const numerW = new Float64Array(nDocs * k);
  const denomW = new Float64Array(nDocs * k);

  for (let iter = 0; iter < TOPIC_ITERATIONS; iter++) {
    // --- H ← H ⊙ (WᵀV) ⊘ (WᵀW·H) ---
    numerH.fill(0);
    for (let d = 0; d < nDocs; d++) {
      const wRow = d * k;
      for (let i = rowPtr[d]; i < rowPtr[d + 1]; i++) {
        const j = cols[i];
        const v = vals[i];
        for (let t = 0; t < k; t++) numerH[t * nTerms + j] += W[wRow + t] * v;
      }
    }
    gram.fill(0); // WᵀW
    for (let d = 0; d < nDocs; d++) {
      const wRow = d * k;
      for (let t = 0; t < k; t++) {
        const wt = W[wRow + t];
        if (wt === 0) continue;
        for (let t2 = 0; t2 < k; t2++) gram[t * k + t2] += wt * W[wRow + t2];
      }
    }
    denomH.fill(0);
    for (let t = 0; t < k; t++) {
      for (let t2 = 0; t2 < k; t2++) {
        const g = gram[t * k + t2];
        if (g === 0) continue;
        const hRow = t2 * nTerms;
        const out = t * nTerms;
        for (let j = 0; j < nTerms; j++) denomH[out + j] += g * H[hRow + j];
      }
    }
    for (let i = 0; i < H.length; i++) {
      H[i] *= numerH[i] / (denomH[i] + EPS);
    }

    // --- W ← W ⊙ (VHᵀ) ⊘ (W·HHᵀ) ---
    numerW.fill(0);
    for (let d = 0; d < nDocs; d++) {
      const wRow = d * k;
      for (let i = rowPtr[d]; i < rowPtr[d + 1]; i++) {
        const j = cols[i];
        const v = vals[i];
        for (let t = 0; t < k; t++) numerW[wRow + t] += v * H[t * nTerms + j];
      }
    }
    gram.fill(0); // HHᵀ
    for (let t = 0; t < k; t++) {
      const hRow = t * nTerms;
      for (let t2 = t; t2 < k; t2++) {
        const h2Row = t2 * nTerms;
        let s = 0;
        for (let j = 0; j < nTerms; j++) s += H[hRow + j] * H[h2Row + j];
        gram[t * k + t2] = s;
        gram[t2 * k + t] = s;
      }
    }
    denomW.fill(0);
    for (let d = 0; d < nDocs; d++) {
      const wRow = d * k;
      for (let t = 0; t < k; t++) {
        let s = 0;
        for (let t2 = 0; t2 < k; t2++) s += W[wRow + t2] * gram[t2 * k + t];
        denomW[wRow + t] = s;
      }
    }
    for (let i = 0; i < W.length; i++) {
      W[i] *= numerW[i] / (denomW[i] + EPS);
    }
  }

  // Fix NMF's scaling freedom: normalise each topic's term row to sum 1 and push
  // that scale into W, so W[d,t] is topic t's real contribution to document d.
  for (let t = 0; t < k; t++) {
    const hRow = t * nTerms;
    let mass = 0;
    for (let j = 0; j < nTerms; j++) mass += H[hRow + j];
    // The rows start strictly positive (rand + EPS) and the multiplicative
    // updates keep them so, so the mass is always positive here.
    for (let j = 0; j < nTerms; j++) H[hRow + j] /= mass;
    for (let d = 0; d < nDocs; d++) W[d * k + t] *= mass;
  }

  // Top terms per topic, from the L1-normalised topic-term rows.
  const terms: TopicTerm[][] = [];
  for (let t = 0; t < k; t++) {
    const hRow = t * nTerms;
    const order = Array.from({ length: nTerms }, (_, j) => j)
      .sort((a, b) => H[hRow + b] - H[hRow + a])
      .slice(0, TOPIC_TERMS);
    terms.push(
      order
        .map((j) => ({ lemma: lemmas[j], weight: round6(H[hRow + j]) }))
        .filter((term) => term.weight > 0), // a term that rounds to 0 is noise
    );
  }

  // Document mixes: each W row re-normalised to a proportion over topics.
  const mix = new Float32Array(nDocs * k);
  for (let d = 0; d < nDocs; d++) {
    const wRow = d * k;
    let sum = 0;
    for (let t = 0; t < k; t++) sum += W[wRow + t];
    if (sum === 0) continue; // empty document: leave its mix all-zero
    for (let t = 0; t < k; t++) mix[wRow + t] = W[wRow + t] / sum;
  }

  return { k, docs, terms, mix };
};

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export const buildArtefacts = (
  catalogue: Catalogue,
  warnings: string[],
  corpus: CorpusScan,
): Artefacts => {
  const encoder = new TextEncoder();

  // Every edition, in catalogue order, with display names denormalised so
  // that search responses need no other source. A co-authored work appears in
  // several authors' lists but is one edition on disk, so it is emitted once
  // (under its host author) and carries all its authors.
  const surnameOf = new Map(catalogue.authors.map((a) => [a.slug, a.surname]));
  const editionRefs: EditionRef[] = [];
  const editionIndex = new Map<string, number>();
  const editionDocs: MarkitDocument[] = [];
  const seenWorks = new Set<Work>();
  for (const author of catalogue.authors) {
    for (const work of author.works) {
      if (seenWorks.has(work)) continue;
      seenWorks.add(work);
      for (const edition of work.editions) {
        editionIndex.set(
          `${work.hostSlug}/${work.slug}/${edition.slug}`,
          editionRefs.length,
        );
        editionDocs.push(edition.document);
        editionRefs.push({
          authors: work.authorSlugs,
          authorNames: work.authorSlugs.map((s) => surnameOf.get(s)!),
          hostSlug: work.hostSlug,
          work: work.slug,
          workBreadcrumb: work.breadcrumb,
          edition: edition.slug,
          canonical: edition.slug === work.canonicalSlug,
          members: [],
        });
      }
    }
  }

  // A composite edition splices borrowed editions' documents in as children —
  // the same objects as the borrowed works' own editions (the identity that
  // blockUnit rests on) — so walking a composed tree finds every borrowed
  // edition, transitively: a borrowed collection carries its own borrows
  // inside its subtree.
  const docEdition = new Map(editionDocs.map((doc, i) => [doc, i]));
  const collectMembers = (doc: MarkitDocument, out: Set<number>): void => {
    for (const child of doc.children) {
      const member = docEdition.get(child);
      if (member !== undefined) out.add(member);
      collectMembers(child, out);
    }
  };
  editionDocs.forEach((doc, i) => {
    const members = new Set<number>();
    collectMembers(doc, members);
    editionRefs[i].members = [...members].sort((a, b) => a - b);
  });

  // Interim, insertion-ordered vocabulary; remapped to sorted ids below. The
  // vocabulary is the union of the edited and original streams; df/cf count
  // occurrences across both (so original-only spellings are still coherent).
  const dictionary = catalogue.dictionary;
  const tempIds = new Map<string, number>();
  const tempPostings: number[][] = []; // edited reading text (every unit)
  const tempReadings: number[][] = []; // resolved reading per edited posting
  const overlayPostings: number[][] = []; // original text (edited units only)
  const overlayReadings: number[][] = []; // resolved reading per overlay posting
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
      tempReadings.push([]);
      overlayPostings.push([]);
      overlayReadings.push([]);
      tempCf.push(0);
      tempDf.push(0);
      tempLastUnit.push(-1);
    }
    return tempId;
  };

  /** Record one occurrence of a surface in a unit: postings, its resolved
   * reading (EXEMPT stored as READING_EXEMPT), cf, and df. The stored position
   * carries CAP_BIT when the occurrence began with a capital. */
  const record = (
    postings: number[][],
    readings: number[][],
    surface: string,
    unitIndex: number,
    position: number,
    capital: boolean,
    reading: number,
  ): number => {
    const tempId = intern(surface);
    postings[tempId].push(unitIndex, capital ? position + CAP_BIT : position);
    readings[tempId].push(reading < 0 ? READING_EXEMPT : reading);
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

  eachUnit(
    catalogue,
    (work, edition, sectionPath, sectionTitle, block, overrides) => {
      const editionIdx = editionIndex.get(
        `${work.hostSlug}/${work.slug}/${edition.slug}`,
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
      // Resolve each token's reading in its edition's orthographic context, from
      // the same extraction walk that produced the offsets (tokenContexts), so
      // context and offset cannot drift.
      const readingOf = resolveTokenReadings(
        spans,
        tokenContexts(block),
        dictionary,
        overrides,
      );

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
        const tempId = record(
          tempPostings,
          tempReadings,
          span.surface,
          unitIndex,
          position,
          isCapital(text[span.start]),
          readingOf[position],
        );
        acc.tokens.push(tempId, units.blobOffset[unitIndex] + span.start);
      }
      totalTokens += spans.length;

      // Where the block carries editorial markup, index its original text into
      // the overlay too, with original-version token positions and readings, so an
      // original search reads this unit from the overlay instead of the (edited)
      // primary.
      if (hasEditorial(block)) {
        affectedUnits.push(unitIndex);
        const originalText = blockText(block, "original");
        const originalSpans = tokenize(originalText);
        const originalReading = resolveTokenReadings(
          originalSpans,
          tokenContexts(block, "original"),
          dictionary,
          overrides,
        );
        for (let position = 0; position < originalSpans.length; position++) {
          const span = originalSpans[position];
          // intern() without record(): the surface enters the vocabulary so
          // original-text queries can resolve it, but df and cf are NOT
          // incremented. This is intentional: df/cf reflect the edited reading
          // text only, so that downstream statistics (word frequency, tf-idf,
          // topic modelling) are grounded in the text as published, not in the
          // manuscript layer. Do not replace this with record() without updating
          // the statistical semantics throughout.
          const tempId = intern(span.surface);
          overlayPostings[tempId].push(
            unitIndex,
            isCapital(originalText[span.start]) ? position + CAP_BIT : position,
          );
          const reading = originalReading[position];
          overlayReadings[tempId].push(reading < 0 ? READING_EXEMPT : reading);
        }
      }

      acc.text += text + "\n";
      acc.blockLines.push(line);
      acc.bytes += line.length;
    },
  );

  // Final, sorted vocabulary; temp ids -> sorted surface ids.
  const surfaces = [...tempIds.keys()].sort();
  const surfaceId = new Map(surfaces.map((s, i) => [s, i]));
  const tempToFinal = new Uint32Array(tempIds.size);
  for (const [surface, tempId] of tempIds) {
    tempToFinal[tempId] = surfaceId.get(surface)!;
  }
  // Per-surface readings, from the register (identity when unregistered). The
  // spelling and lemma bucket tables (the search levels) and every lemma-keyed
  // statistic derive from these — no spelling/stemming heuristics of the
  // computer's own. Stored per surface so the reading index on each posting can
  // be resolved back to its words at serve time.
  const readings = surfaces.map((surface) =>
    surfaceReadings(surface, dictionary)
  );
  const vocab: Vocab = {
    surfaces,
    readings,
    df: new Array(surfaces.length),
    cf: new Array(surfaces.length),
  };
  for (const [surface, tempId] of tempIds) {
    const id = surfaceId.get(surface)!;
    vocab.df[id] = tempDf[tempId];
    vocab.cf[id] = tempCf[tempId];
  }
  // Distinct spelling and lemma words across every reading — the sizes of the
  // two search-level bucket spaces, for the manifest stats.
  const spellingSet = new Set<string>();
  const lemmaSet = new Set<string>();
  for (const perSurface of readings) {
    for (const reading of perSurface) {
      for (const word of reading) {
        spellingSet.add(word.spelling);
        lemmaSet.add(word.lemma);
      }
    }
  }

  // Pack a (tempId-indexed) postings table grouped by final surface id, with
  // each posting's resolved reading index parallel to its (unit, position) pair.
  const packPostings = (
    sourcePairs: number[][],
    sourceReadings: number[][],
  ): Postings => {
    const offsets = new Uint32Array(surfaces.length + 1);
    let total = 0;
    for (let id = 0; id < surfaces.length; id++) {
      offsets[id] = total;
      total += sourcePairs[tempIds.get(surfaces[id])!].length / 2;
    }
    offsets[surfaces.length] = total;
    const pairs = new Uint32Array(total * 2);
    const readingIds = new Uint32Array(total);
    for (let id = 0; id < surfaces.length; id++) {
      const tempId = tempIds.get(surfaces[id])!;
      pairs.set(sourcePairs[tempId], offsets[id] * 2);
      readingIds.set(sourceReadings[tempId], offsets[id]);
    }
    return { offsets, pairs, readings: readingIds };
  };
  const postings = packPostings(tempPostings, tempReadings);
  const overlay = packPostings(overlayPostings, overlayReadings);

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
  const catalogueArtefact: CatalogueArtefact = {
    authors: catalogue.authors.map((author) => ({
      meta: authorMeta(author),
      works: author.works.map((work) => ({
        meta: workMeta(work),
        editions: work.editions.map((edition) => ({
          meta: editionMeta(edition),
          units: edition.document.blocks
            .map((block) => blockUnit.get(block))
            .filter((unit): unit is number => unit !== undefined),
          sections: sectionTree(
            edition.document,
            [],
            undefined,
            edition.authorSlugs,
          )
            .map((section) => skeletonSection(section, blockUnit)),
        })),
      })),
    })),
    editionSlugs: [...new Set(editionRefs.map((e) => e.edition))].sort(),
  };

  // `seenWorks` holds each work once (a co-authored work is listed under
  // several authors), so its size is the distinct work count.
  const works = seenWorks.size;
  const dtm = buildDtm(vocab, units, postings);
  return {
    manifest: {
      pipelineVersion: PIPELINE_VERSION,
      builtAt: new Date().toISOString(),
      corpus,
      stats: {
        authors: catalogue.authors.length,
        works,
        editions: editionRefs.length,
        units: units.edition.length,
        tokens: totalTokens,
        surfaces: surfaces.length,
        spellings: spellingSet.size,
        lemmas: lemmaSet.size,
      },
      editionSlugs: catalogueArtefact.editionSlugs,
      editions: editionRefs,
      warnings,
    },
    catalogue: catalogueArtefact,
    vocab,
    units,
    postings,
    overlayPostings: overlay,
    affectedUnits,
    editions,
    dtm,
    topics: buildTopics(dtm),
  };
};
