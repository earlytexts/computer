/**
 * Read-only access to the built artefacts the curation tools work against.
 * They never touch the corpus directly: the surface vocabulary, its
 * frequencies, canonical spellings and inferred lemmas all come from the last
 * `deno task build`. Pointing at a fresh build is how the tools "adapt when
 * the corpus is rebuilt" — every run re-reads the current vocabulary and the
 * build fingerprint, and progress is keyed by surface so it carries over.
 */

/** The slice of vocab.json the curation tools need. */
export type Vocab = {
  surfaces: string[];
  /** surface index -> index into spellings */
  surfaceSpelling: number[];
  /** units containing each surface */
  df: number[];
  /** total occurrences of each surface */
  cf: number[];
  /** distinct canonical spellings (the spelling-tolerant search bucket) */
  spellings: string[];
  /** surface index -> heuristic citation-form lemma */
  surfaceLemma: string[];
};

export type Manifest = {
  builtAt: string;
  pipelineVersion: string;
  stats: Record<string, number>;
};

export const artefactsDir = (): string =>
  Deno.env.get("ARTEFACTS_DIR") ||
  decodeURIComponent(new URL("../../artefacts", import.meta.url).pathname);

const read = async <T>(dir: string, file: string): Promise<T> => {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/${file}`)) as T;
  } catch (cause) {
    throw new Error(
      `Could not read ${file} from ${dir}. ` +
        `Build the artefacts first: \`deno task build\`.`,
      { cause },
    );
  }
};

export const loadArtefacts = async (): Promise<{
  dir: string;
  vocab: Vocab;
  manifest: Manifest;
}> => {
  const dir = artefactsDir();
  const [vocab, manifest] = await Promise.all([
    read<Vocab>(dir, "vocab.json"),
    read<Manifest>(dir, "manifest.json"),
  ]);
  return { dir, vocab, manifest };
};
