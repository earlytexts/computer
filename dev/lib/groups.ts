/**
 * Grouping helpers for the "groups with" / "family" context lines. Both tools
 * want, for a surface, the *other* surfaces that share something with it — the
 * search bucket (same normalised form) for variants, the citation lemma for
 * lemmas — so a human can see at a glance whether an old spelling is united
 * with its modern cousins or stranded among only-archaic forms.
 *
 * Groupings are built from the artefacts as last built. A mapping the user
 * adds this session is reflected immediately in the *mapping* shown, but the
 * regrouping it causes only lands on the next `deno task build`.
 */

import { dim } from "./term.ts";

/** Bucket surface indices by a key string (norm or lemma), commonest first. */
export const groupBy = (
  keys: string[],
  cf: number[],
): Map<string, number[]> => {
  const groups = new Map<string, number[]>();
  keys.forEach((key, i) => {
    const list = groups.get(key) ?? groups.set(key, []).get(key)!;
    list.push(i);
  });
  for (const list of groups.values()) list.sort((a, b) => cf[b] - cf[a]);
  return groups;
};

/** A dim "<label>: a · b · c … (+n)" line over the group members minus self. */
export const groupLine = (
  label: string,
  members: number[],
  self: number,
  surfaces: string[],
  limit = 6,
): string => {
  const others = members.filter((i) => i !== self);
  if (others.length === 0) return dim(`${label}: —`);
  const shown = others.slice(0, limit).map((i) => surfaces[i]).join(" · ");
  const more = others.length > limit ? ` … (+${others.length - limit})` : "";
  return dim(`${label}: ${shown}${more}`);
};
