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
  CompareResponse,
  CompareSectionResponse,
  EditionMeta,
  EditionResponse,
  FrequencyResponse,
  SearchResponse,
  SectionResponse,
  SectionSummary,
  WorkMeta,
} from "../../types.ts";

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
  } of the phrase "${response.q}", grouped by ${response.by} ` +
    `(sorted by count; relative = per 1000 tokens):\n\n${rows}`;
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
