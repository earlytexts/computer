/**
 * Read/write the override JSON files (src/lib/variants.json, lemmas.json).
 * The files carry a leading comment key (`__comment` / `NOTE`) and their key
 * order is meaningful, so we round-trip the parsed object untouched and only
 * append or replace string entries. Serialised to match `deno fmt`.
 */

export type Overrides = Record<string, unknown>;

export const loadOverrides = async (path: string): Promise<Overrides> => {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Overrides;
  } catch {
    return {};
  }
};

export const saveOverrides = async (
  path: string,
  obj: Overrides,
): Promise<void> => {
  await Deno.writeTextFile(path, JSON.stringify(obj, null, 2) + "\n");
};

/** Reserved (non-entry) keys: the documentation blocks at the top of the files. */
const reserved = (key: string): boolean =>
  key.startsWith("_") || key === "NOTE";

/** The override mapped to `key`, or undefined if there isn't a real one. */
export const lookup = (obj: Overrides, key: string): string | undefined => {
  const value = obj[key];
  return typeof value === "string" && !reserved(key) ? value : undefined;
};
