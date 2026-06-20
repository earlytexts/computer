/**
 * The corpus tools: thin wrappers over the computer's `Computer` interface,
 * each returning plain text rendered by render.ts. Handlers throw on bad
 * arguments (the caller reports the message back to the model as an error
 * result) and return a friendly "not found" string for 404s so the model can
 * recover. This is the single source of truth for the tools the Companion
 * exposes and the MCP server serves; it depends only on the `Computer`
 * interface, so it runs over HTTP (a client) or in-process (localComputer).
 */

import type { Computer } from "../client.ts";
import type { MatchLevel } from "../types.ts";
import {
  renderAuthors,
  renderCompare,
  renderCompareSection,
  renderEdition,
  renderFrequency,
  renderSearch,
  renderSection,
  renderWorks,
} from "./render.ts";

/** An LLM tool definition: a name, a description, and a JSON Schema for input. */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolSet = {
  definitions: ToolSpec[];
  run: (name: string, input: unknown) => Promise<string>;
};

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`missing required string argument "${key}"`);
  }
  return value;
};

const strOpt = (
  input: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const numOpt = (
  input: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
};

const boolOpt = (
  input: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
};

const strArray = (input: Record<string, unknown>, key: string): string[] => {
  const value = input[key];
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`missing required string array argument "${key}"`);
  }
  return value;
};

const slugProperty = (description: string) => ({
  type: "string" as const,
  description,
});

const authorProperty = slugProperty('Author slug, e.g. "hume".');
const workProperty = slugProperty('Work slug within the author, e.g. "epm".');
const editionProperty = slugProperty(
  'Edition slug: a year like "1751" or "1742a". Omit to use the work\'s canonical edition (the default).',
);
const pathProperty = {
  type: "array" as const,
  items: { type: "string" as const },
  description:
    "Section path: slugs from the edition root down to the section, as shown in the table of contents.",
};
const matchProperty = {
  type: "string" as const,
  enum: ["exact", "spelling", "form"],
  description:
    'How strictly to match each word. "exact": the spelling as written. ' +
    '"spelling": unite old and modern spellings (encrease = increase) but ' +
    'keep distinct inflections. "form": also unite plurals and inflections. ' +
    'Defaults to "form" (the most tolerant). Use "exact" for spelling ' +
    "questions or precise quotation.",
};

export const createTools = (computer: Computer): ToolSet => {
  const definitions: ToolSpec[] = [
    {
      name: "list_authors",
      description:
        "List every author in the corpus with slug, name, dates, nationality, sex, and year of first publication. Call this to resolve an author's name to a slug or to answer questions about who is in the corpus.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "get_author_works",
      description:
        "List one author's works and their editions (slugs, titles, publication years, and whether each text is imported or a stub). Call this to resolve a work's title to a slug or to see which editions exist.",
      inputSchema: {
        type: "object",
        properties: { author: authorProperty },
        required: ["author"],
        additionalProperties: false,
      },
    },
    {
      name: "search",
      description:
        'Full-text search over the corpus. The whole query is matched as one phrase (its words must appear consecutively, in order) — no quoting needed. Returns matching blocks with the phrase marked «…», each cited with author/work/edition, section path, and block id. Matching is tolerant by default ("form" level): it ignores case and unites old and modern spellings, plurals, and inflections ("connection between cause and effect" finds "connexion betwixt causes and effects"). Use the match parameter to tighten this, and/or caseSensitive to require initial capitalisation to agree. By default only canonical editions are searched (one hit per work); optionally scope to an author or work, to a single edition (a year slug), or pass edition "all" to search every printing.',
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "The phrase to search for." },
          match: matchProperty,
          caseSensitive: {
            type: "boolean",
            description:
              "Require each word's initial capitalisation to agree with the text. Defaults to false (case is ignored).",
          },
          author: authorProperty,
          work: workProperty,
          edition: slugProperty(
            'Limit to one edition (a year slug like "1751"), or "all" to search every printing. Omit to search only canonical editions (the default).',
          ),
          page: {
            type: "number",
            description: "Result page, starting at 1; defaults to 1.",
          },
        },
        required: ["q"],
        additionalProperties: false,
      },
    },
    {
      name: "frequency",
      description:
        'Count how often a phrase occurs across the corpus and report it grouped by author, work, or edition. Like search, the whole query is matched as one phrase and matching is tolerant by default (use match and/or caseSensitive to tighten it). Each group reports the occurrence count, its total token count, and a relative rate (occurrences per 1000 tokens) so groups of different sizes can be compared. Call this to answer "how common is X" or "who uses X most" questions; use search to see the actual passages. Optionally scope to an author, work, or single edition.',
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "The phrase to count." },
          by: {
            type: "string",
            enum: ["author", "work", "edition"],
            description:
              'Group occurrences by "author", "work", or "edition". Defaults to "work".',
          },
          match: matchProperty,
          caseSensitive: {
            type: "boolean",
            description:
              "Require each word's initial capitalisation to agree with the text. Defaults to false (case is ignored).",
          },
          author: authorProperty,
          work: workProperty,
          edition: slugProperty(
            'Limit to one edition (a year slug like "1751"). Omit to count across all editions.',
          ),
        },
        required: ["q"],
        additionalProperties: false,
      },
    },
    {
      name: "get_edition",
      description:
        "Get an edition's metadata, front matter, and full table of contents (section paths, titles, and stub flags). With no edition, returns the work's canonical edition. Call this before fetching sections, to find the right section paths.",
      inputSchema: {
        type: "object",
        properties: {
          author: authorProperty,
          work: workProperty,
          edition: editionProperty,
        },
        required: ["author", "work"],
        additionalProperties: false,
      },
    },
    {
      name: "get_section",
      description:
        "Get the full text of one section of an edition, with its subsections listed, previous/next sections, and which other editions contain a matching section. With no edition, reads the work's canonical edition. Fetch only the sections you need; texts can be long.",
      inputSchema: {
        type: "object",
        properties: {
          author: authorProperty,
          work: workProperty,
          edition: editionProperty,
          path: pathProperty,
        },
        required: ["author", "work", "path"],
        additionalProperties: false,
      },
    },
    {
      name: "compare_editions",
      description:
        "Align the section trees of two editions of a work in reading order, showing which sections appear in both and which only in one. Call this to see what was added, dropped, or moved between editions; use compare_section for word-level differences.",
      inputSchema: {
        type: "object",
        properties: {
          author: authorProperty,
          work: workProperty,
          a: { ...editionProperty, description: "First edition slug." },
          b: { ...editionProperty, description: "Second edition slug." },
        },
        required: ["author", "work", "a", "b"],
        additionalProperties: false,
      },
    },
    {
      name: "compare_section",
      description:
        "Show the word-level differences in one section between two editions of a work: [-…-] marks text only in the first edition, {+…+} text only in the second; unchanged blocks are truncated.",
      inputSchema: {
        type: "object",
        properties: {
          author: authorProperty,
          work: workProperty,
          a: { ...editionProperty, description: "First edition slug." },
          b: { ...editionProperty, description: "Second edition slug." },
          path: pathProperty,
        },
        required: ["author", "work", "a", "b", "path"],
        additionalProperties: false,
      },
    },
  ];

  const notFound = (what: string): string =>
    `Not found: ${what}. Check the slugs with list_authors, get_author_works, or get_edition.`;

  const handlers: Record<
    string,
    (input: Record<string, unknown>) => Promise<string>
  > = {
    list_authors: async () => renderAuthors((await computer.catalog()).authors),
    get_author_works: async (input) => {
      const slug = str(input, "author");
      const author = (await computer.catalog()).authors.find(
        (candidate) => candidate.slug === slug,
      );
      return author === undefined
        ? notFound(`author "${slug}"`)
        : renderWorks(author);
    },
    search: async (input) =>
      renderSearch(
        await computer.search({
          q: str(input, "q"),
          match: strOpt(input, "match") as MatchLevel | undefined,
          caseSensitive: boolOpt(input, "caseSensitive"),
          author: strOpt(input, "author"),
          work: strOpt(input, "work"),
          edition: strOpt(input, "edition"),
          page: numOpt(input, "page"),
        }),
      ),
    frequency: async (input) =>
      renderFrequency(
        await computer.frequency({
          q: str(input, "q"),
          by: strOpt(input, "by") as "author" | "work" | "edition" | undefined,
          match: strOpt(input, "match") as MatchLevel | undefined,
          caseSensitive: boolOpt(input, "caseSensitive"),
          author: strOpt(input, "author"),
          work: strOpt(input, "work"),
          edition: strOpt(input, "edition"),
        }),
      ),
    get_edition: async (input) => {
      const [author, work, edition] = [
        str(input, "author"),
        str(input, "work"),
        strOpt(input, "edition"),
      ];
      const response = await computer.edition(author, work, edition);
      const which = edition ?? "canonical";
      return response === undefined
        ? notFound(`edition ${author}/${work}/${which}`)
        : renderEdition(response);
    },
    get_section: async (input) => {
      const [author, work, edition] = [
        str(input, "author"),
        str(input, "work"),
        strOpt(input, "edition"),
      ];
      const path = strArray(input, "path");
      const response = await computer.section(author, work, edition, path);
      const which = edition ?? "canonical";
      return response === undefined
        ? notFound(`section ${author}/${work}/${which} § ${path.join("/")}`)
        : renderSection(response);
    },
    compare_editions: async (input) => {
      const [author, work, a, b] = [
        str(input, "author"),
        str(input, "work"),
        str(input, "a"),
        str(input, "b"),
      ];
      const response = await computer.compare(author, work, a, b);
      return response === undefined
        ? notFound(`editions ${a} and ${b} of ${author}/${work}`)
        : renderCompare(response);
    },
    compare_section: async (input) => {
      const [author, work, a, b] = [
        str(input, "author"),
        str(input, "work"),
        str(input, "a"),
        str(input, "b"),
      ];
      const path = strArray(input, "path");
      const response = await computer.compareSection(author, work, a, b, path);
      return response === undefined
        ? notFound(
          `section ${
            path.join("/")
          } in editions ${a} and ${b} of ${author}/${work}`,
        )
        : renderCompareSection(response);
    },
  };

  return {
    definitions,
    run: (name, input) => {
      const handler = handlers[name];
      if (handler === undefined) {
        return Promise.reject(new Error(`unknown tool "${name}"`));
      }
      return handler((input ?? {}) as Record<string, unknown>);
    },
  };
};
