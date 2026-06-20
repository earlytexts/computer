/**
 * Small helpers for asserting on the Markit blocks the computer returns in its
 * responses: the plain text under a node, the text of every element of a given
 * type (deletions, insertions, emphasis…), and the text of highlight marks.
 */

/** Plain text under a node (all nested plainText, in order). */
export const textOf = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (typeof value !== "object" || value === null) return "";
  const el = value as Record<string, unknown>;
  if (el.type === "plainText") return el.content as string;
  return textOf(el.content);
};

/** The text of every element of the given type, anywhere in a value. */
export const ofType = (value: unknown, type: string): string[] => {
  if (Array.isArray(value)) return value.flatMap((v) => ofType(v, type));
  if (typeof value !== "object" || value === null) return [];
  const el = value as Record<string, unknown>;
  if (el.type === type) return [textOf(el.content)];
  return ofType(el.content, type);
};

/** The text of every highlight mark, anywhere in a value. */
export const marks = (value: unknown): string[] => ofType(value, "highlight");
