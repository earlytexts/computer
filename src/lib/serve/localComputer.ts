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
  findAuthorEntry,
  findEditionEntry,
  findWorkEntry,
} from "./store.ts";
import {
  catalogResponse,
  compareResponse,
  compareSectionResponse,
  concordanceResponse,
  editionResponse,
  frequencyResponse,
  fullTextResponse,
  searchResponse,
  sectionFullTextResponse,
  sectionResponse,
} from "./api.ts";
import type { Computer } from "../../client.ts";

const lower = (slug: string): string => slug.toLowerCase();
const lowerPath = (path: string[]): string[] => path.map(lower);

export const localComputer = (
  artefacts: ServeArtefacts,
  store: BlockStore,
): Computer => {
  // Resolve author and work entries; slugs are lowercased to match the HTTP
  // routes (server.ts lowercases every path segment).
  const authorWork = (author: string, work: string) => {
    const authorEntry = findAuthorEntry(artefacts.catalog, lower(author));
    const workEntry = authorEntry === undefined
      ? undefined
      : findWorkEntry(authorEntry, lower(work));
    return authorEntry === undefined || workEntry === undefined
      ? undefined
      : { author: authorEntry, work: workEntry };
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
        found.author,
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
          found.author,
          found.work,
          found.edition,
          version,
        );
    },
    section: (author, work, edition, path, version) => {
      const found = resolve(author, work, edition);
      return found === undefined ? Promise.resolve(undefined) : sectionResponse(
        store,
        found.author,
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
          found.author,
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
        compareResponse(pair.author, pair.work, lower(a), lower(b)),
      );
    },
    compareSection: (author, work, a, b, path, version) => {
      const pair = authorWork(author, work);
      return pair === undefined
        ? Promise.resolve(undefined)
        : compareSectionResponse(
          store,
          pair.author,
          pair.work,
          lower(a),
          lower(b),
          lowerPath(path),
          version,
        );
    },
    search: (params) => searchResponse(artefacts, params),
    frequency: (params) =>
      Promise.resolve(frequencyResponse(artefacts, params)),
    concordance: (params) => concordanceResponse(artefacts, params),
  };
};
