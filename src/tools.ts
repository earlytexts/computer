/**
 * The corpus tools: thin wrappers over the computer's `Computer` interface,
 * each returning plain text rendered by render.ts. Handlers throw on bad
 * arguments (the caller reports the message back to the model as an error
 * result) and return a friendly "not found" string for 404s so the model can
 * recover. This is the single source of truth for the tools the Companion
 * exposes and the MCP server serves; it depends only on the `Computer`
 * interface, so it runs over HTTP (a client) or in-process (localComputer).
 */

import type {
  Computer,
  KeyMode,
  MatchLevel,
  SimilarLevel,
  TopicLevel,
} from "./types.ts";
import {
  renderAuthors,
  renderCollocations,
  renderCompare,
  renderCompareSection,
  renderConcordance,
  renderEdition,
  renderFrequency,
  renderKeywords,
  renderSearch,
  renderSection,
  renderSimilar,
  renderTopicMix,
  renderTopics,
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

const strArrayOpt = (
  input: Record<string, unknown>,
  key: string,
): string[] | undefined => {
  const value = input[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : undefined;
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
            'Limit to one edition (a year slug like "1751"), or "all" for every printing. Omit to count canonical editions only (the default).',
          ),
        },
        required: ["q"],
        additionalProperties: false,
      },
    },
    {
      name: "concordance",
      description:
        "Show every occurrence of a phrase keyword-in-context: one line per occurrence (not per block), with a window of context words on each side and the keyword marked «…». Like search, the whole query is matched as one phrase and matching is tolerant by default (use match and/or caseSensitive to tighten it). Call this to study how a word or phrase is actually used across the corpus — the words it keeps company with — rather than reading whole blocks. Lines can be ordered by corpus position (default) or by the words nearest the keyword on the left or right. Optionally scope to an author, work, or single edition.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "The phrase to show in context." },
          context: {
            type: "number",
            description:
              "Context words to keep on each side of the keyword (default 6, max 25).",
          },
          sort: {
            type: "string",
            enum: ["position", "left", "right"],
            description:
              'Line order: "position" (corpus order, the default), or by the words nearest the keyword on the "left" or "right".',
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
            'Limit to one edition (a year slug like "1751"), or "all" for every printing. Omit to use canonical editions only (the default).',
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
      name: "keywords",
      description:
        'Find the words a part of the corpus uses more than the rest of it — its distinctive vocabulary (keyness). Unlike search and frequency, this takes no phrase: name a target author (and optionally a work) and it returns the terms statistically over-represented there compared with the rest of the corpus, ranked by log-likelihood (G², the strength of evidence) with a log-ratio (the effect size). Use it to characterise an author or work — to answer "what is distinctively Humean", "what marks out this treatise". Terms are grouped by lemma by default (causes/caused → cause); use "form" to also keep spelling variants together, or "surface" for the exact spellings as written. No phrase needed — the statistics surface the words for you.',
      inputSchema: {
        type: "object",
        properties: {
          author: {
            ...authorProperty,
            description:
              'Target author slug, e.g. "hume" — the author whose distinctive words you want.',
          },
          work: {
            ...workProperty,
            description:
              "Optional target work slug within the author, to find what is distinctive of one work rather than the whole author.",
          },
          edition: slugProperty(
            'Edition universe both sides are drawn from: a year slug, "all" for every printing, or omit for canonical editions only (the default).',
          ),
          by: {
            type: "string",
            enum: ["lemma", "form", "surface"],
            description:
              'How to group terms. "lemma" (default): citation forms (causes/caused → cause). "form": unite spelling variants and inflections. "surface": the exact spellings as written.',
          },
          min: {
            type: "number",
            description:
              "Minimum occurrences in the target for a term to be considered (default 5); raise it to cut rare-word noise.",
          },
          limit: {
            type: "number",
            description: "Maximum terms to return (default 50, max 500).",
          },
        },
        required: ["author"],
        additionalProperties: false,
      },
    },
    {
      name: "collocations",
      description:
        'Find the words that cluster around a node word — its collocates, the company it keeps. Give a word and it returns the terms that occur within a few tokens of it more often than chance, the conceptual neighbourhood of the term (what surrounds "liberty", "cause", "passion"). Each collocate carries three association measures, which disagree by design: log-likelihood (G², the default ranking — confident, often grammatical collocates), PMI (the effect size — rarer, tightly-bound lexical neighbours like a fixed phrase), and a t-score (frequency-weighted confidence). Like search, the node word is matched tolerantly by default (use match to tighten it); collocates are grouped by lemma by default (use "form" or "surface"). By default the whole corpus (canonical editions) is measured; scope to an author, work, or single edition. This complements keywords: keywords finds distinctive single words, collocations finds distinctive pairings.',
      inputSchema: {
        type: "object",
        properties: {
          q: {
            type: "string",
            description: "The node word whose collocates you want.",
          },
          by: {
            type: "string",
            enum: ["lemma", "form", "surface"],
            description:
              'How to group collocates. "lemma" (default): citation forms (causes/caused → cause). "form": unite spelling variants and inflections. "surface": the exact spellings as written.',
          },
          match: matchProperty,
          window: {
            type: "number",
            description:
              "How many tokens on each side of the node word count as its neighbourhood (default 5, max 25).",
          },
          min: {
            type: "number",
            description:
              "Minimum times a collocate must occur near the node word to be reported (default 3); raise it to cut noise.",
          },
          limit: {
            type: "number",
            description: "Maximum collocates to return (default 50, max 500).",
          },
          author: authorProperty,
          work: workProperty,
          edition: slugProperty(
            'Limit to one edition (a year slug like "1751"), or "all" for every printing. Omit to use canonical editions only (the default).',
          ),
        },
        required: ["q"],
        additionalProperties: false,
      },
    },
    {
      name: "similar",
      description:
        'Find the corpus items most lexically similar to a target — what else reads like it. Name a target author and work (and optionally a specific edition, or a section path) and it returns the items whose vocabulary most resembles the target, by cosine similarity over TF-IDF vectors, with an opaque 0–1 score (higher is more alike). The level sets the granularity of both the target and the results: "section" compares one section against every other section, "edition" a whole edition against others, "work" a whole work against others. It defaults to "section" when a path is given, otherwise "edition". The target\'s own work is always excluded, and results are drawn from each work\'s canonical edition. Use it for discovery — "what other passages treat this subject", "which works most resemble this one" — where keywords and collocations characterise a text, this finds its neighbours.',
      inputSchema: {
        type: "object",
        properties: {
          author: {
            ...authorProperty,
            description:
              'Target author slug, e.g. "hume" — the item to find lookalikes for lives here.',
          },
          work: workProperty,
          edition: slugProperty(
            'Target edition (a year slug like "1751"). Omit for the work\'s canonical edition. Ignored at the "work" level.',
          ),
          path: {
            ...pathProperty,
            description:
              "Target section path (slugs from the edition root). Give it to compare one section; omit it to compare a whole edition or work.",
          },
          level: {
            type: "string",
            enum: ["section", "edition", "work"],
            description:
              'Granularity of the target and the results. "section": a single section. "edition": a whole edition. "work": a whole work. Defaults to "section" when a path is given, else "edition".',
          },
          limit: {
            type: "number",
            description: "Maximum items to return (default 20, max 200).",
          },
        },
        required: ["author", "work"],
        additionalProperties: false,
      },
    },
    {
      name: "topics",
      description:
        'Survey the corpus\'s themes through its topic model — a set of unsupervised topics learned over the whole corpus (NMF over the TF-IDF document vectors). Each topic is a cluster of words that co-occur across documents (e.g. religion and miracles, or commerce and money), reported as its highest-weight terms together with the works it is most prominent in — so you can see what the corpus is about and trace a theme across authors and decades. Takes no target; use topic_mix for one work\'s themes. Use it for the big picture — "what are the main themes in the corpus", "which works are most about <theme>" — where keywords and similarity work from a text you name, this starts from the themes themselves.',
      inputSchema: {
        type: "object",
        properties: {
          terms: {
            type: "number",
            description: "Top terms to show per topic (default 12, max 25).",
          },
          works: {
            type: "number",
            description:
              "Prominent works to list per topic (default 8, max 50).",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "topic_mix",
      description:
        'Show what a particular text is about, as a mix over the corpus\'s topics. Name a target author and work (and optionally a specific edition, or a section path) and it returns the topics the target draws on most, each with its share of the text (0–1) and its top terms. The level sets the granularity: "section" a single section, "edition" a whole edition, "work" a whole work; it defaults to "section" when a path is given, otherwise "edition". Use it to characterise a text thematically — "what is this work mainly about", "which themes run through this section" — and pair it with the topics tool (which defines the topics and shows where each is prominent across the corpus).',
      inputSchema: {
        type: "object",
        properties: {
          author: {
            ...authorProperty,
            description:
              'Target author slug, e.g. "hume" — the text whose topic mix you want lives here.',
          },
          work: workProperty,
          edition: slugProperty(
            'Target edition (a year slug like "1751"). Omit for the work\'s canonical edition. Ignored at the "work" level.',
          ),
          path: {
            ...pathProperty,
            description:
              "Target section path (slugs from the edition root). Give it for one section's mix; omit it for a whole edition or work.",
          },
          level: {
            type: "string",
            enum: ["section", "edition", "work"],
            description:
              'Granularity of the target. "section": a single section. "edition": a whole edition. "work": a whole work. Defaults to "section" when a path is given, else "edition".',
          },
          limit: {
            type: "number",
            description:
              "Maximum topics to return, by descending share (default 10).",
          },
        },
        required: ["author", "work"],
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
    concordance: async (input) =>
      renderConcordance(
        await computer.concordance({
          q: str(input, "q"),
          context: numOpt(input, "context"),
          sort: strOpt(input, "sort") as
            | "position"
            | "left"
            | "right"
            | undefined,
          match: strOpt(input, "match") as MatchLevel | undefined,
          caseSensitive: boolOpt(input, "caseSensitive"),
          author: strOpt(input, "author"),
          work: strOpt(input, "work"),
          edition: strOpt(input, "edition"),
          page: numOpt(input, "page"),
        }),
      ),
    keywords: async (input) =>
      renderKeywords(
        await computer.keywords({
          author: str(input, "author"),
          work: strOpt(input, "work"),
          edition: strOpt(input, "edition"),
          by: strOpt(input, "by") as KeyMode | undefined,
          min: numOpt(input, "min"),
          limit: numOpt(input, "limit"),
        }),
      ),
    collocations: async (input) =>
      renderCollocations(
        await computer.collocations({
          q: str(input, "q"),
          by: strOpt(input, "by") as KeyMode | undefined,
          match: strOpt(input, "match") as MatchLevel | undefined,
          window: numOpt(input, "window"),
          min: numOpt(input, "min"),
          limit: numOpt(input, "limit"),
          author: strOpt(input, "author"),
          work: strOpt(input, "work"),
          edition: strOpt(input, "edition"),
        }),
      ),
    similar: async (input) =>
      renderSimilar(
        await computer.similar({
          author: str(input, "author"),
          work: str(input, "work"),
          edition: strOpt(input, "edition"),
          path: strArrayOpt(input, "path"),
          level: strOpt(input, "level") as SimilarLevel | undefined,
          limit: numOpt(input, "limit"),
        }),
      ),
    topics: async (input) =>
      renderTopics(
        await computer.topics({
          terms: numOpt(input, "terms"),
          works: numOpt(input, "works"),
        }),
      ),
    topic_mix: async (input) =>
      renderTopicMix(
        await computer.topicMix({
          author: str(input, "author"),
          work: str(input, "work"),
          edition: strOpt(input, "edition"),
          path: strArrayOpt(input, "path"),
          level: strOpt(input, "level") as TopicLevel | undefined,
          limit: numOpt(input, "limit"),
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
