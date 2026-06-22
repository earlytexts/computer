/**
 * Small helpers for asserting on the Markit blocks the computer returns in its
 * responses: the plain text under a node, the text of every element of a given
 * type (deletions, insertions, emphasis…), and the text of highlight marks.
 * The walk descends through every structural carrier — inline `content`, list
 * `items`/`nestedList`, and table `rows`/`cells` — so list and table text is
 * reached as readily as paragraph text.
 */

/** The keys under which a Markit node carries its children, in render order. */
const childKeys = ["content", "items", "nestedList", "rows", "cells"] as const;

const children = (el: Record<string, unknown>): unknown[] =>
  childKeys.map((key) => el[key]);

/** Plain text under a node (all nested plainText, in order). */
export const textOf = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (typeof value !== "object" || value === null) return "";
  const el = value as Record<string, unknown>;
  if (el.type === "plainText") return el.content as string;
  return children(el).map(textOf).join("");
};

/** The text of every element of the given type, anywhere in a value. */
export const ofType = (value: unknown, type: string): string[] => {
  if (Array.isArray(value)) return value.flatMap((v) => ofType(v, type));
  if (typeof value !== "object" || value === null) return [];
  const el = value as Record<string, unknown>;
  if (el.type === type) return [textOf(el)];
  return children(el).flatMap((v) => ofType(v, type));
};

/** The text of every highlight mark, anywhere in a value. */
export const marks = (value: unknown): string[] => ofType(value, "highlight");
