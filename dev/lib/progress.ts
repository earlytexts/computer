/**
 * Resumable curation progress. A surface is "accounted for" when it has an
 * override (read live from the JSON file) or has been explicitly confirmed
 * here; skipped surfaces stay in the remaining pool and come back round next
 * time. Progress is keyed by surface string, so it survives a corpus rebuild:
 * stale keys are simply ignored, new surfaces show up as unaccounted.
 *
 * `builtAt` records the artefact build this progress was last touched against,
 * only so the tool can tell the user when the corpus has been rebuilt since.
 */

export type Progress = {
  builtAt: string;
  confirmed: string[];
  skipped: string[];
};

export const loadProgress = async (path: string): Promise<Progress> => {
  try {
    const p = JSON.parse(await Deno.readTextFile(path)) as Partial<Progress>;
    return {
      builtAt: p.builtAt ?? "",
      confirmed: p.confirmed ?? [],
      skipped: p.skipped ?? [],
    };
  } catch {
    return { builtAt: "", confirmed: [], skipped: [] };
  }
};

export const saveProgress = async (
  path: string,
  p: Progress,
): Promise<void> => {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify(
      {
        builtAt: p.builtAt,
        confirmed: [...p.confirmed].sort(),
        skipped: [...p.skipped].sort(),
      },
      null,
      2,
    ) + "\n",
  );
};
