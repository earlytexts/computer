/**
 * Render the computer's API responses as compact plain text for the model's
 * tool results. Block content goes through Markit's renderText (the corpus's
 * canonical plain-text rendering); everything here is presentation only — no
 * text processing logic lives in the companion.
 */

import { endLine, renderText, startLine } from "@earlytexts/markit";
import type {
  Block,
  BlockElement,
  InlineElement,
  ListItem,
  Paragraph,
} from "@earlytexts/markit";
import type {
  AlignedRow,
  CatalogAuthor,
  CollocationsResponse,
  CompareResponse,
  CompareSectionResponse,
  ConcordanceResponse,
  EditionMeta,
  EditionResponse,
  FrequencyResponse,
  FullTextResponse,
  KeywordsResponse,
  SearchResponse,
  SectionContent,
  SectionFullTextResponse,
  SectionResponse,
  SectionSummary,
  SimilarResponse,
  TopicMixResponse,
  TopicsResponse,
  WorkMeta,
} from "./types.ts";

/* ------------------------------ blocks ------------------------------- */

/**
 * Make markup that Markit's renderText would otherwise hide visible in plain
 * text: search highlights become «…», and editorial markup (which appears in
 * a diff document, or a ?version=both retrieval) becomes [-deleted-] / {+
 * inserted+}. Replacing the elements with plain markers means renderText keeps
 * the deleted side instead of dropping it.
 */
const markInline = (elements: InlineElement[]): InlineElement[] =>
  elements.flatMap((element): InlineElement[] => {
    if (element.type === "highlight") {
      return [
        { type: "plainText", content: "«" },
        ...markInline(element.content),
        { type: "plainText", content: "»" },
      ];
    }
    if (element.type === "deletion") {
      return [
        { type: "plainText", content: "[-" },
        ...markInline(element.content),
        { type: "plainText", content: "-]" },
      ];
    }
    if (element.type === "insertion") {
      return [
        { type: "plainText", content: "{+" },
        ...markInline(element.content),
        { type: "plainText", content: "+}" },
      ];
    }
    if ("content" in element && Array.isArray(element.content)) {
      return [
        { ...element, content: markInline(element.content) } as InlineElement,
      ];
    }
    return [element];
  });

const markParagraph = (paragraph: Paragraph): Paragraph => ({
  ...paragraph,
  content: markInline(paragraph.content),
});

const markListItem = (item: ListItem): ListItem => ({
  ...item,
  content: markInline(item.content),
  nestedList: item.nestedList === undefined ? undefined : {
    ...item.nestedList,
    items: item.nestedList.items.map(markListItem),
  },
});

const markBlockElement = (element: BlockElement): BlockElement => {
  switch (element.type) {
    case "paragraph":
      return markParagraph(element);
    case "heading":
      return {
        ...element,
        content: element.content.map((line) => ({
          ...line,
          content: markInline(line.content),
        })),
      };
    case "blockquote":
      return { ...element, content: element.content.map(markParagraph) };
    case "list":
      return { ...element, items: element.items.map(markListItem) };
    case "table":
      return {
        ...element,
        rows: element.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({
            ...cell,
            content: markInline(cell.content),
          })),
        })),
      };
  }
};

const markHighlights = (block: Block): Block => ({
  ...block,
  content: block.content.map(markBlockElement),
});

export const renderBlocks = (blocks: Block[]): string =>
  renderText({
    id: "",
    blocks: blocks.map(markHighlights),
    children: [],
    [startLine]: 0,
    [endLine]: 0,
  }).trim();

/* ------------------------------ catalog ------------------------------ */

const span = (birth?: number, death?: number): string =>
  birth === undefined && death === undefined
    ? ""
    : ` (${birth ?? "?"}–${death ?? "?"})`;

export const renderAuthors = (authors: CatalogAuthor[]): string =>
  authors.map((author) => {
    const name = [author.title, author.forename, author.surname]
      .filter((part) => part !== undefined).join(" ");
    const facts = [
      author.nationality,
      author.sex,
      author.published === undefined
        ? undefined
        : `first published ${author.published}`,
      `${author.works.length} work${author.works.length === 1 ? "" : "s"}`,
    ].filter((part) => part !== undefined).join(", ");
    return `${author.slug} — ${name}${span(author.birth, author.death)}` +
      (facts === "" ? "" : ` — ${facts}`);
  }).join("\n");

const renderEditionMeta = (edition: EditionMeta, canonical: string): string =>
  `${edition.slug}${edition.slug === canonical ? " (canonical)" : ""}` +
  `${edition.imported ? "" : " [stub]"}`;

const renderWorkMeta = (work: WorkMeta): string =>
  `${work.slug} — ${work.title} (${work.published.join(", ")})` +
  `${work.imported ? "" : " [stub]"}\n` +
  `  editions: ${
    work.editions.map((e) => renderEditionMeta(e, work.canonicalSlug)).join(
      ", ",
    )
  }`;

export const renderWorks = (author: CatalogAuthor): string =>
  `Works of ${author.forename} ${author.surname} (${author.slug}), ` +
  `with edition slugs ("(canonical)" marks each work's default edition; ` +
  `[stub] means the text is not in the corpus):\n\n` +
  author.works.map(renderWorkMeta).join("\n");

/* ------------------------------- texts ------------------------------- */

const renderToc = (sections: SectionSummary[], depth: number): string =>
  sections.map((section) =>
    `${"  ".repeat(depth)}${section.path.join("/")} — ${section.title}` +
    `${section.imported ? "" : " [stub]"}\n` +
    renderToc(section.children, depth + 1)
  ).join("");

const editionHeader = (
  response: {
    author: { surname: string };
    work: WorkMeta;
    edition: EditionMeta;
  },
): string =>
  `${response.author.surname}, ${response.work.title} — edition "${response.edition.slug}"` +
  ` (published ${response.edition.published.join(", ")})` +
  `${response.edition.imported ? "" : " [stub]"}`;

export const renderEdition = (response: EditionResponse): string =>
  `${editionHeader(response)}\n` +
  `Copytext: ${response.edition.copytext.join("; ") || "n/a"}\n\n` +
  (response.blocks.length === 0 ? "" : `${renderBlocks(response.blocks)}\n\n`) +
  `Sections (path — title):\n${renderToc(response.sections, 0)}`;

export const renderSection = (response: SectionResponse): string => {
  const { section } = response;
  const parts = [
    `${editionHeader(response)} § ${section.path.join("/")}`,
    section.breadcrumb,
    section.imported
      ? renderBlocks(section.blocks)
      : "[stub — this section's text is not in the corpus]",
  ];
  if (section.children.length > 0) {
    parts.push(`Subsections:\n${renderToc(section.children, 0)}`.trimEnd());
  }
  const nav = [
    response.prev === undefined
      ? undefined
      : `previous: ${response.prev.path.join("/")}`,
    response.next === undefined
      ? undefined
      : `next: ${response.next.path.join("/")}`,
  ].filter((part) => part !== undefined);
  if (nav.length > 0) parts.push(nav.join(" | "));
  if (response.compareEditions.length > 0) {
    parts.push(
      `Matching section also in editions: ${
        response.compareEditions.map((e) => e.slug).join(", ")
      }`,
    );
  }
  return parts.join("\n\n");
};

/** A section's text and every descendant's, depth-first under heading lines. */
const renderSectionContent = (section: SectionContent): string => {
  const heading = `§ ${section.path.join("/")} — ${section.title}` +
    (section.imported ? "" : " [stub]");
  const body = section.imported
    ? renderBlocks(section.blocks)
    : "[stub — this section's text is not in the corpus]";
  return [
    `${heading}\n${body}`.trimEnd(),
    ...section.children.map(renderSectionContent),
  ].join("\n\n");
};

export const renderFullText = (response: FullTextResponse): string =>
  `${editionHeader(response)}\n` +
  `Copytext: ${response.edition.copytext.join("; ") || "n/a"}\n\n` +
  (response.blocks.length === 0 ? "" : `${renderBlocks(response.blocks)}\n\n`) +
  response.sections.map(renderSectionContent).join("\n\n");

export const renderSectionFullText = (
  response: SectionFullTextResponse,
): string => {
  const parts = [
    `${editionHeader(response)} § ${response.section.path.join("/")}`,
    response.section.breadcrumb,
    renderSectionContent(response.section),
  ];
  const nav = [
    response.prev === undefined
      ? undefined
      : `previous: ${response.prev.path.join("/")}`,
    response.next === undefined
      ? undefined
      : `next: ${response.next.path.join("/")}`,
  ].filter((part) => part !== undefined);
  if (nav.length > 0) parts.push(nav.join(" | "));
  if (response.compareEditions.length > 0) {
    parts.push(
      `Matching section also in editions: ${
        response.compareEditions.map((e) => e.slug).join(", ")
      }`,
    );
  }
  return parts.join("\n\n");
};

/* ------------------------------- search ------------------------------ */

const matchLabel: Record<SearchResponse["match"], string> = {
  exact: "exact spelling",
  spelling: "spelling-tolerant",
  form: "tolerant",
};

const searchMode = (response: SearchResponse): string => {
  const flags = [
    matchLabel[response.match],
    ...(response.caseSensitive ? ["case-sensitive"] : []),
  ];
  return flags.join(", ");
};

export const renderSearch = (response: SearchResponse): string => {
  if (response.total === 0) {
    return `No results for the phrase "${response.q}" (${
      searchMode(response)
    }).`;
  }
  const results = response.results.map((result, index) =>
    `${index + 1}. ${result.author}/${result.work}/${result.edition} § ${
      result.sectionPath.join("/")
    } (${result.sectionTitle}) [${result.blockId}]\n` +
    renderBlocks([result.block])
  ).join("\n\n");
  return `${response.total} blocks containing the phrase "${response.q}" ` +
    `(${searchMode(response)}, page ${response.page} of ${response.pages}; ` +
    `matches marked «…»):\n\n${results}`;
};

/* ----------------------------- frequency ----------------------------- */

export const renderFrequency = (response: FrequencyResponse): string => {
  if (response.total === 0) {
    return `No occurrences of the phrase "${response.q}".`;
  }
  const rows = response.results.map((entry) =>
    `${entry.label} — ${entry.count} occurrence${
      entry.count === 1 ? "" : "s"
    } in ${entry.tokens} tokens (${entry.relative} per 1000)`
  ).join("\n");
  return `${response.total} occurrence${
    response.total === 1 ? "" : "s"
  } of the phrase "${response.q}", grouped by ${response.groupBy} ` +
    `(sorted by count; relative = per 1000 tokens):\n\n${rows}`;
};

/* ---------------------------- concordance ---------------------------- */

export const renderConcordance = (response: ConcordanceResponse): string => {
  if (response.total === 0) {
    return `No occurrences of the phrase "${response.q}".`;
  }
  const lines = response.lines.map((line) => {
    const left = (line.leftTruncated ? "… " : "") + line.left;
    const right = line.right + (line.rightTruncated ? " …" : "");
    const cite = `${line.author}/${line.work}/${line.edition} § ${
      line.sectionPath.join("/")
    } [${line.blockId}]`;
    return `${left} «${line.keyword}» ${right}\n    — ${cite}`;
  }).join("\n");
  return `${response.total} occurrence${
    response.total === 1 ? "" : "s"
  } of the phrase "${response.q}" in context ` +
    `(page ${response.page} of ${response.pages}; keyword marked «…»):\n\n${lines}`;
};

/* ------------------------------ keywords ----------------------------- */

export const renderKeywords = (response: KeywordsResponse): string => {
  const scope = [response.author, response.work].filter((p) => p !== null)
    .join("/") || "the corpus";
  if (response.total === 0) {
    return `No distinctive vocabulary found for ${scope} ` +
      `(by ${response.by}). It may have too little text, or no reference to ` +
      `compare against.`;
  }
  const rows = response.results.map((entry, index) =>
    `${index + 1}. ${entry.term} — G²=${entry.logLikelihood}, ` +
    `log-ratio=${entry.logRatio} ` +
    `(${entry.target}× here vs ${entry.reference}× elsewhere; ` +
    `${entry.targetRelative} vs ${entry.referenceRelative} per 1000)`
  ).join("\n");
  return `Words distinctive of ${scope}, by ${response.by} ` +
    `(${response.version} text), ranked by log-likelihood (G²); ` +
    `log-ratio is the effect size:\n\n${rows}`;
};

/* ---------------------------- collocations --------------------------- */

export const renderCollocations = (response: CollocationsResponse): string => {
  const scope = [response.author, response.work].filter((p) => p !== null)
    .join("/") || "the corpus";
  if (response.nodeCount === 0) {
    return `No occurrences of "${response.q}" found in ${scope}, so there ` +
      `are no collocations to report.`;
  }
  if (response.total === 0) {
    return `"${response.q}" occurs ${response.nodeCount}× in ${scope}, but no ` +
      `collocate meets the minimum count. Lower min, or widen the window.`;
  }
  const rows = response.results.map((entry, index) =>
    `${index + 1}. ${entry.term} — G²=${entry.logLikelihood}, ` +
    `PMI=${entry.pmi}, t=${entry.tScore} ` +
    `(${entry.cooccurrence}× near, ${entry.total}× total)`
  ).join("\n");
  return `Words collocating with "${response.q}" in ${scope}, by ` +
    `${response.by} within ±${response.window} tokens ` +
    `(${response.nodeCount} occurrences), ranked by log-likelihood (G²); ` +
    `PMI is the effect size, t a frequency-weighted confidence:\n\n${rows}`;
};

/* ------------------------------ similar ------------------------------ */

export const renderSimilar = (response: SimilarResponse): string => {
  const target = [
    response.author,
    response.work,
    response.edition,
    ...response.sectionPath,
  ].filter((p) => p !== null && p !== undefined).join("/") || "the target";
  if (!response.found) {
    return `No ${response.level} found for ${target}, or it has no indexed ` +
      `text, so there is nothing to compare.`;
  }
  if (response.total === 0) {
    return `Nothing in the corpus is lexically similar to ${target} ` +
      `(by ${response.level}).`;
  }
  const cite = (entry: SimilarResponse["results"][number]): string => {
    const parts = [entry.author, entry.work, entry.edition]
      .filter((p) => p !== null).join("/");
    return response.level === "section" && entry.sectionPath.length > 0
      ? `${parts} § ${entry.sectionPath.join("/")}` +
        (entry.sectionTitle ? ` (${entry.sectionTitle})` : "")
      : parts;
  };
  const rows = response.results.map((entry, index) =>
    `${index + 1}. ${cite(entry)} — similarity ${entry.score}`
  ).join("\n");
  return `Corpus ${response.level}s most lexically similar to ${target}, ` +
    `ranked by cosine similarity (0–1) over TF-IDF vectors ` +
    `(the target's own work is excluded):\n\n${rows}`;
};

/* ------------------------------ topics ------------------------------- */

const termList = (terms: { lemma: string }[]): string =>
  terms.map((term) => term.lemma).join(", ");

export const renderTopics = (response: TopicsResponse): string => {
  if (response.k === 0) {
    return "The corpus has no topic model (it has no indexed text).";
  }
  const blocks = response.topics.map((topic) => {
    const lines = [`Topic ${topic.id} — ${termList(topic.terms)}`];
    if (topic.prominent.length > 0) {
      const works = topic.prominent
        .map((work) =>
          `${work.authorName}, ${work.workBreadcrumb} (${work.weight})`
        )
        .join("; ");
      lines.push(`  prominent in: ${works}`);
    }
    return lines.join("\n");
  }).join("\n\n");
  return `The corpus's ${response.k} topics (unsupervised, by NMF over the ` +
    `TF-IDF document vectors). Each lists its highest-weight terms and the ` +
    `works it is most prominent in (the topic's share of the work, 0–1):` +
    `\n\n${blocks}`;
};

export const renderTopicMix = (response: TopicMixResponse): string => {
  const target = [
    response.author,
    response.work,
    response.edition,
    ...response.sectionPath,
  ].filter((part) => part !== null && part !== undefined).join("/") ||
    "the target";
  if (!response.found) {
    return `No ${response.level} found for ${target}, or it has no indexed ` +
      `text, so there is no topic mix.`;
  }
  const rows = response.topics.map((topic) =>
    `${topic.weight} — topic ${topic.id} (${termList(topic.terms)})`
  ).join("\n");
  return `The topic mix of ${target} (by ${response.level}), the topics it ` +
    `draws on most, with each topic's share (0–1) and its top terms:` +
    `\n\n${rows}`;
};

/* ------------------------------ compare ------------------------------ */

const renderRows = (
  rows: AlignedRow[],
  a: string,
  b: string,
  depth: number,
): string =>
  rows.map((row) => {
    const where = row.pathA !== undefined && row.pathB !== undefined
      ? `in both (${row.pathA.join("/")})`
      : row.pathA !== undefined
      ? `ONLY IN ${a} (${row.pathA.join("/")})`
      : `ONLY IN ${b} (${row.pathB?.join("/")})`;
    return `${"  ".repeat(depth)}${row.title} — ${where}\n` +
      renderRows(row.children, a, b, depth + 1);
  }).join("");

export const renderCompare = (response: CompareResponse): string =>
  `${response.author.surname}, ${response.work.title}: sections of edition ` +
  `"${response.a.slug}" aligned with edition "${response.b.slug}":\n\n` +
  renderRows(response.rows, response.a.slug, response.b.slug, 0);

export const renderCompareSection = (
  response: CompareSectionResponse,
): string => {
  const header =
    `${response.author.surname}, ${response.work.title}, "${response.title}": ` +
    `edition "${response.a.slug}" vs edition "${response.b.slug}" ` +
    `(${response.version} text). ` +
    `[-…-] appears only in ${response.a.slug}, {+…+} only in ${response.b.slug}.`;
  // The diff is a Markit document; renderBlocks shows its editorial markup.
  const body = renderBlocks(response.blocks);
  const children = response.childRows.length === 0
    ? ""
    : `\n\nSubsections:\n${
      renderRows(response.childRows, response.a.slug, response.b.slug, 0)
    }`;
  return `${header}\n\n${body}${children}`;
};
