/**
 * An in-process implementation of the `Computer` interface, backed by the API
 * builders in api.ts instead of HTTP. It lets the tools in tools.ts run inside
 * the computer (for the MCP server) with no network hop: the same builders the
 * REST routes serve, the same slug→entry resolution server.ts does, returning
 * the typed responses (or undefined for not-found) the interface promises.
 */

import type { ServeArtefacts } from "../artefacts.ts";
import {
  type BlockStore,
  type DtmStore,
  findAuthorEntry,
  findEditionEntry,
  type TokenStore,
  type TopicsStore,
} from "./store.ts";
import type { WorkEntry } from "../artefacts.ts";
import {
  catalogResponse,
  collocationsResponse,
  compareResponse,
  compareSectionResponse,
  concordanceResponse,
  editionResponse,
  frequencyResponse,
  fullTextResponse,
  keywordsResponse,
  searchResponse,
  sectionFullTextResponse,
  sectionResponse,
  similarResponse,
  topicMixResponse,
  topicsResponse,
} from "./api.ts";
import type { Computer } from "../../types.ts";

const lower = (slug: string): string => slug.toLowerCase();
const lowerPath = (path: string[]): string[] => path.map(lower);

export const localComputer = (
  artefacts: ServeArtefacts,
  store: BlockStore,
  tokens: TokenStore,
  dtm: DtmStore,
  topics: TopicsStore,
): Computer => {
  // Every work keyed by its host path `<hostSlug>/<workSlug>` — a single author's
  // slug, or a joint slug ("astell-norris") for a co-authored work. This is the
  // one URL a work lives at; the co-authored work is reached only by its joint
  // host, not under either author.
  const byHost = new Map<string, WorkEntry>();
  for (const a of artefacts.catalog.authors) {
    for (const w of a.works) {
      byHost.set(`${w.meta.hostSlug}/${w.meta.slug}`, w);
    }
  }

  // Resolve a work by its host path, and the full list of its authors (so every
  // response carries them). Slugs are lowercased to match the HTTP routes
  // (server.ts lowercases every path segment).
  const authorWork = (host: string, work: string) => {
    const workEntry = byHost.get(`${lower(host)}/${lower(work)}`);
    if (workEntry === undefined) return undefined;
    // The work's authors, mapped to their metadata for the response; every slug
    // names a catalog author (the build registered the work under each).
    const authors = workEntry.meta.authorSlugs.map(
      (slug) => findAuthorEntry(artefacts.catalog, slug)!.meta,
    );
    return { authors, work: workEntry };
  };

  // As above, plus an edition entry, defaulting to the work's canonical edition
  // when none is named — the same default the HTTP routes apply.
  const resolve = (author: string, work: string, edition?: string) => {
    const pair = authorWork(author, work);
    if (pair === undefined) return undefined;
    const editionEntry = findEditionEntry(
      pair.work,
      lower(edition ?? pair.work.meta.canonicalSlug),
    );
    return editionEntry === undefined
      ? undefined
      : { ...pair, edition: editionEntry };
  };

  return {
    catalog: () => Promise.resolve(catalogResponse(artefacts.catalog)),
    edition: (author, work, edition, version) => {
      const found = resolve(author, work, edition);
      return found === undefined ? Promise.resolve(undefined) : editionResponse(
        store,
        found.authors,
        found.work,
        found.edition,
        version,
      );
    },
    fullText: (author, work, edition, version) => {
      const found = resolve(author, work, edition);
      return found === undefined
        ? Promise.resolve(undefined)
        : fullTextResponse(
          store,
          found.authors,
          found.work,
          found.edition,
          version,
        );
    },
    section: (author, work, edition, path, version) => {
      const found = resolve(author, work, edition);
      return found === undefined ? Promise.resolve(undefined) : sectionResponse(
        store,
        found.authors,
        found.work,
        found.edition,
        lowerPath(path),
        version,
      );
    },
    sectionFullText: (author, work, edition, path, version) => {
      const found = resolve(author, work, edition);
      return found === undefined
        ? Promise.resolve(undefined)
        : sectionFullTextResponse(
          store,
          found.authors,
          found.work,
          found.edition,
          lowerPath(path),
          version,
        );
    },
    compare: (author, work, a, b) => {
      const pair = authorWork(author, work);
      // compareResponse resolves the two edition slugs itself.
      return pair === undefined ? Promise.resolve(undefined) : Promise.resolve(
        compareResponse(pair.authors, pair.work, lower(a), lower(b)),
      );
    },
    compareSection: (author, work, a, b, path, version) => {
      const pair = authorWork(author, work);
      return pair === undefined
        ? Promise.resolve(undefined)
        : compareSectionResponse(
          store,
          pair.authors,
          pair.work,
          lower(a),
          lower(b),
          lowerPath(path),
          version,
        );
    },
    search: (params) => searchResponse(store, artefacts, params),
    frequency: (params) =>
      Promise.resolve(frequencyResponse(artefacts, params)),
    concordance: (params) => concordanceResponse(store, artefacts, params),
    keywords: (params) => Promise.resolve(keywordsResponse(artefacts, params)),
    collocations: (params) => collocationsResponse(tokens, artefacts, params),
    similar: (params) => similarResponse(dtm, artefacts, params),
    topics: (params) => topicsResponse(topics, artefacts, params),
    topicMix: (params) => topicMixResponse(topics, artefacts, params),
  };
};
