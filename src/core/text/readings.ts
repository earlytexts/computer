/**
 * Per-occurrence reading resolution: given the tokens of a block (with their
 * character offsets) and the context the extraction walk saw around them, decide
 * which dictionary *reading* each occurrence is — its normalised spelling and
 * lemma — by the precedence chain the corpus defines (`resolveReading`): the
 * token's own `[w:surface=value]` element, then the enclosing text's
 * `[metadata.dictionary]` override, then the entry's first (default) reading.
 *
 * This is the read side of the corpus dictionary (CLAUDE.md's boundary: the
 * computer consumes the compiled register, it does not author or validate it).
 * The three search levels and every lemma-keyed statistic derive from the
 * result:
 *  - the SPELLING bucket is the resolved reading's spelling(s);
 *  - the FORM/LEMMA bucket is the resolved reading's lemma(s).
 * A surface not in the register indexes as itself (identity reading); a token
 * inside exempting markup (person / place / org / citation / language) indexes
 * verbatim too, never normalised (the EXEMPT sentinel), so citation contents and
 * names stay as printed.
 *
 * The result is an index into the surface's `surfaceReadings` list (or EXEMPT),
 * one per token, which the builder stores alongside each posting — so a reader
 * can later ask for the reading of any single occurrence, and statistics count
 * every occurrence under the reading it actually resolved to.
 */

import type { Dictionary, Overrides, Reading } from "@earlytexts/corpus/wire";
import { resolveReading } from "@earlytexts/corpus/wire";
import type { TokenSpan } from "./tokenize.ts";
import type { ContextSpan } from "./text.ts";

/** Sentinel reading index: the occurrence indexes verbatim (identity), because
 * it sits inside exempting markup. The builder maps it to `[{surface, surface}]`;
 * it is never a real index into a surface's readings list. */
export const EXEMPT = -1;

/** The readings a surface can have, in default-first order: its register entry's
 * expanded readings, or a lone identity reading when the surface is unregistered
 * (best-effort until backfill completes). The one definition the build and serve
 * sides share, so a stored reading index means the same on both. */
export const surfaceReadings = (
  surface: string,
  dictionary: Dictionary,
): Reading[] =>
  dictionary[surface]?.readings ?? [[{ spelling: surface, lemma: surface }]];

/**
 * The resolved reading index of every token, parallel to `spans`. `contexts`
 * are the block's plain-text runs with their exemption / `[w:]` value (from
 * `tokenContexts`), sorted by offset; `overrides` is the enclosing text's
 * merged `[metadata.dictionary]` map. A token inside exempting markup resolves
 * to EXEMPT; otherwise its reading is chosen by the precedence chain and
 * reported as its index into `surfaceReadings(surface)`.
 */
export const resolveTokenReadings = (
  spans: TokenSpan[],
  contexts: ContextSpan[],
  dictionary: Dictionary,
  overrides: Overrides,
): number[] => {
  let cursor = 0;
  return spans.map((span) => {
    // Advance to the context run containing this token's start offset. Every
    // token sits inside one plainText run, so a run always covers it.
    while (cursor < contexts.length && contexts[cursor].end <= span.start) {
      cursor++;
    }
    const context = contexts[cursor];
    if (context?.exemption !== undefined) return EXEMPT;
    const entry = dictionary[span.surface];
    if (entry === undefined) return 0; // identity: the lone reading is index 0
    const reading = resolveReading(
      entry,
      overrides[span.surface],
      context?.wordValue,
    );
    return entry.readings.indexOf(reading);
  });
};
