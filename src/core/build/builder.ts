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
import type { AuthorMeta, EditionMeta, WorkMeta } from "../../types.ts";
import {
  blockText,
  buildSurfaceLemma,
  formKey,
  hasEditorial,
  normalizeSpelling,
  tokenize,
} from "../text/mod.ts";
import {
  type Artefacts,
  type BuiltEdition,
  CAP_BIT,
  type CatalogArtefact,
  type CorpusScan,
  type EditionRef,
  PIPELINE_VERSION,
  type Postings,
  type SkeletonSection,
  type UnitTable,
  type Vocab,
} from "../artefacts.ts";

/* ------------------------------- build ------------------------------- */

/** Whether a token's first character is a capital letter (for CAP_BIT). */
const isCapital = (first: string): boolean =>
  first !== first.toLowerCase() && first === first.toUpperCase();

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
  canonicalSlug: work.canonicalSlug,
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
          canonical: edition.slug === work.canonicalSlug,
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

  /** Record one occurrence of a surface in a unit: postings, cf, and df. The
   * stored position carries CAP_BIT when the occurrence began with a capital. */
  const record = (
    postings: number[][],
    surface: string,
    unitIndex: number,
    position: number,
    capital: boolean,
  ): number => {
    const tempId = intern(surface);
    postings[tempId].push(unitIndex, capital ? position + CAP_BIT : position);
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
      const tempId = record(
        tempPostings,
        span.surface,
        unitIndex,
        position,
        isCapital(text[span.start]),
      );
      acc.tokens.push(tempId, units.blobOffset[unitIndex] + span.start);
    }
    totalTokens += spans.length;

    // Where the block carries editorial markup, index its original text into
    // the overlay too, with original-version token positions, so an original
    // search reads this unit from the overlay instead of the (edited) primary.
    if (hasEditorial(block)) {
      affectedUnits.push(unitIndex);
      const originalText = blockText(block, "original");
      const originalSpans = tokenize(originalText);
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
  // Per-surface canonical spelling and form bucket, then the distinct sorted
  // tables they index into. The form bucket is built on the spelling, not the
  // raw surface, so the levels nest: surface ⊃ spelling ⊃ form.
  const spellingOf = surfaces.map(normalizeSpelling);
  const formOf = spellingOf.map(formKey);
  const spellings = [...new Set(spellingOf)].sort();
  const forms = [...new Set(formOf)].sort();
  const spellingId = new Map(spellings.map((s, i) => [s, i]));
  const formIdMap = new Map(forms.map((f, i) => [f, i]));
  const vocab: Vocab = {
    surfaces,
    surfaceSpelling: spellingOf.map((s) => spellingId.get(s)!),
    surfaceForm: formOf.map((f) => formIdMap.get(f)!),
    df: new Array(surfaces.length),
    cf: new Array(surfaces.length),
    spellings,
    forms,
    surfaceLemma: buildSurfaceLemma(spellingOf),
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
        spellings: spellings.length,
        forms: forms.length,
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
