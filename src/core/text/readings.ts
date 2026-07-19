/**
 * Per-occurrence reading resolution: given a block's tokens (markit's, with
 * the wrapper context the extraction walk saw around them), decide which
 * dictionary *reading* each occurrence is — its normalised spelling and lemma —
 * by the precedence chain the corpus defines (`resolveReading`): the token's
 * own `[w:surface=value]` element, then the enclosing text's
 * `[metadata.dictionary]` override, then the entry's first (default) reading.
 *
 * This is the read side of the corpus dictionary (CLAUDE.md's boundary: the
 * computer consumes the compiled register, it does not author or validate it).
 * The three search levels and every lemma-keyed statistic derive from the
 * result:
 *  - the SPELLING bucket is the resolved reading's spelling(s);
 *  - the FORM/LEMMA bucket is the resolved reading's lemma(s).
 * A surface not in the register indexes as itself (identity reading); a token
 * inside exempting markup (person / place / org / citation / language, per the
 * corpus's `exemptionOf` policy over the token's context) indexes verbatim,
 * never normalised (the EXEMPT sentinel), so citation contents and names stay
 * as printed.
 *
 * The result is an index into the surface's `surfaceReadings` list (or EXEMPT),
 * one per token, which the builder stores alongside each posting — so a reader
 * can later ask for the reading of any single occurrence, and statistics count
 * every occurrence under the reading it actually resolved to.
 */

import type { Token } from "@earlytexts/markit";
import type {
  Dictionary,
  Entry,
  Overrides,
  Reading,
} from "@earlytexts/corpus/wire";
import {
  exemptionOf,
  fold,
  possessiveBase,
  readingLemma,
  readingSpelling,
  resolveReading,
} from "@earlytexts/corpus/wire";

/** Sentinel reading index: the occurrence indexes verbatim (identity), because
 * it sits inside exempting markup. The builder maps it to `[{surface, surface}]`;
 * it is never a real index into a surface's readings list. */
export const EXEMPT = -1;

/** The readings a surface can have, in default-first order: its register entry's
 * expanded readings, the possessive rule's derived readings (see `entryFor`),
 * or identity readings when neither applies (best-effort until backfill
 * completes). Identity of an n-word surface is n identity words — the same rule
 * as the corpus's own expansion of a `null` entry — so a search for either half
 * finds an unregistered fused unit too. The one definition the build and serve
 * sides share, so a stored reading index means the same on both. */
export const surfaceReadings = (
  surface: string,
  dictionary: Dictionary,
): Reading[] =>
  entryFor(surface, dictionary)?.readings ??
    [surface.split(" ").map((word) => ({ spelling: word, lemma: word }))];

/**
 * The resolved reading index of every token, parallel to `tokens`. `overrides`
 * is the enclosing text's merged `[metadata.dictionary]` map. A token inside
 * exempting markup resolves to EXEMPT; otherwise its reading is chosen by the
 * precedence chain (the token's own `[w:]` value first) and reported as its
 * index into `surfaceReadings(surface)`.
 */
export const resolveTokenReadings = (
  tokens: Token[],
  dictionary: Dictionary,
  overrides: Overrides,
): number[] =>
  tokens.map((token) => {
    if (exemptionOf(token) !== undefined) return EXEMPT;
    const surface = fold(token.text);
    const entry = entryFor(surface, dictionary);
    if (entry === undefined) return 0; // identity: the lone reading is index 0
    const reading = resolveReading(entry, overrides[surface], token.word);
    return entry.readings.indexOf(reading);
  });

/** The entry governing a surface: its own register entry, or — the possessive
 * rule — a derived entry when the surface is `base + 's` and only the base is
 * registered (`bishop's` takes `bishop`'s readings, the clitic appended to each
 * printed spelling, every lemma kept). Explicit entries win, so a registered
 * `'s` surface (a contraction like `it's`, a possessive with its own lemma)
 * keeps its authored readings; `undefined` when neither the surface nor, for a
 * possessive, its base is registered, and the caller falls back to identity. */
const entryFor = (
  surface: string,
  dictionary: Dictionary,
): Entry | undefined => {
  const entry = dictionary[surface];
  if (entry !== undefined) return entry;
  const base = possessiveBase(surface);
  if (base === undefined) return undefined;
  const baseEntry = dictionary[base];
  if (baseEntry === undefined) return undefined;
  return {
    readings: possessiveReadings(baseEntry, surface.slice(base.length)),
  };
};

/** The base entry's readings turned possessive: each reading collapses to one
 * word carrying the base's lemma, with the clitic (`'s` / `’s`) on its printed
 * spelling — so `bishop's` reads as lemma `bishop`, and a respelt base
 * normalises too (`humane's` → spelling `human's`, lemma `human`). */
const possessiveReadings = (baseEntry: Entry, clitic: string): Reading[] =>
  baseEntry.readings.map((reading) => [{
    spelling: readingSpelling(reading) + clitic,
    lemma: readingLemma(reading),
  }]);
