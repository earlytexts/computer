/**
 * The imperative shell: the one module that touches the filesystem. Everything
 * below it is either pure (buildArtefacts, the codec in artefacts.ts, isFresh)
 * or reaches the disk only through a port defined here — a CatalogueReader for
 * the corpus's compiled output and a BlockReader for lazy per-request block
 * reads. The entry points construct `denoIo` and pass it to the pipeline; tests
 * pass an in-memory equivalent.
 *
 * The corpus is consumed as the compiled `catalogue/` the corpus build produces
 * (catalogue.json + per-edition documents), never by scanning `.mit` directly.
 *
 * Invariant: this is the only file in src/ that calls Deno's filesystem APIs.
 */

import type {
  CatalogueFile,
  CatalogueReader,
  RawDoc,
} from "./build/catalogue.ts";
import type { Dictionary } from "@earlytexts/corpus/wire";
import type { BlockReader } from "./serve/store.ts";
import {
  ARTEFACT_FILES,
  type ArtefactFiles,
  type CorpusScan,
  type Manifest,
} from "./artefacts.ts";

/** The filesystem capabilities the build and serve pipelines need. */
export interface Io extends CatalogueReader {
  /** Fingerprint the compiled catalogue (its size and modification time). */
  scanCorpus(corpusDir: string): Promise<CorpusScan>;
  /** The artefacts' manifest, or null when absent (the freshness probe). */
  readManifest(dir: string): Promise<Manifest | null>;
  /** Read the fixed artefact tables (not the per-edition block files). */
  readArtefacts(dir: string): Promise<ArtefactFiles>;
  /** Write serialized artefacts to `dir`, replacing what was there. */
  writeArtefacts(dir: string, files: ArtefactFiles): Promise<void>;
  /** A lazy block reader rooted at an artefacts directory. */
  blockReader(dir: string): BlockReader;
}

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
};

/** A cheap djb2 content hash, stable across copies of identical content. */
const hash = (text: string): number => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) | 0;
  return h;
};

/**
 * Fingerprint the compiled catalogue by the *content* of its `catalogue.json`
 * and `dictionary.json` (the corpus build rewrites the whole `catalogue/` each
 * run, so these change whenever anything in the corpus — text or register —
 * does). We hash the content rather than stat mtime because mtime is not
 * preserved across a deploy snapshot (e.g. Deno Deploy), which would make
 * freshly-built artefacts look stale at boot and trigger a rebuild on a
 * read-only filesystem. Absent when the corpus was never built. The dictionary
 * is folded in so a register-only edit (which need not touch catalogue.json)
 * still invalidates the derived artefacts.
 */
const scanCorpus = async (corpusDir: string): Promise<CorpusScan> => {
  try {
    const catalogue = await Deno.readTextFile(
      `${corpusDir}/catalogue/catalogue.json`,
    );
    const dictionary = await Deno.readTextFile(
      `${corpusDir}/catalogue/dictionary.json`,
    ).catch(() => ""); // absent for a corpus compiled before the dictionary
    return {
      files: catalogue.length + dictionary.length,
      modified: hash(`${catalogue}\0${dictionary}`),
    };
  } catch {
    return { files: 0, modified: 0 };
  }
};

const readManifest = async (dir: string): Promise<Manifest | null> => {
  try {
    return JSON.parse(
      await Deno.readTextFile(`${dir}/${ARTEFACT_FILES.manifest}`),
    ) as Manifest;
  } catch {
    return null;
  }
};

const readArtefacts = async (dir: string): Promise<ArtefactFiles> => {
  const files: ArtefactFiles = new Map();
  for (const name of Object.values(ARTEFACT_FILES)) {
    files.set(name, await Deno.readFile(`${dir}/${name}`));
  }
  return files;
};

/**
 * Write the serialized artefacts to `dir`, replacing what was there. Refuses to
 * clear a directory that doesn't look like an artefacts directory. The manifest
 * is written last, so a directory with a manifest is a complete build.
 */
const writeArtefacts = async (
  dir: string,
  files: ArtefactFiles,
): Promise<void> => {
  let existing: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) existing.push(entry.name);
  } catch {
    existing = [];
  }
  if (existing.length > 0) {
    if (!existing.includes(ARTEFACT_FILES.manifest)) {
      throw new Error(
        `${dir} is not empty and has no ${ARTEFACT_FILES.manifest}; ` +
          `refusing to replace it`,
      );
    }
    await Deno.remove(dir, { recursive: true });
  }
  await Deno.mkdir(dir, { recursive: true });
  for (const [rel, bytes] of files) {
    if (rel === ARTEFACT_FILES.manifest) continue;
    const path = `${dir}/${rel}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, bytes);
  }
  const manifest = files.get(ARTEFACT_FILES.manifest);
  if (manifest !== undefined) {
    await Deno.writeFile(`${dir}/${ARTEFACT_FILES.manifest}`, manifest);
  }
};

const blockReader = (dir: string): BlockReader => ({
  readText: async (relPath) => {
    try {
      return await Deno.readTextFile(`${dir}/${relPath}`);
    } catch {
      return null; // a stub edition has no blocks file
    }
  },
  readRange: async (relPath, offset, length) => {
    const path = `${dir}/${relPath}`;
    const buffer = new Uint8Array(length);
    const file = await Deno.open(path, { read: true });
    try {
      await file.seek(offset, Deno.SeekMode.Start);
      let read = 0;
      while (read < length) {
        const n = await file.read(buffer.subarray(read));
        if (n === null) throw new Error(`unexpected EOF in ${path}`);
        read += n;
      }
    } finally {
      file.close();
    }
    return buffer;
  },
  readBytes: async (relPath) => {
    try {
      return await Deno.readFile(`${dir}/${relPath}`);
    } catch {
      return null; // a stub edition has no tokens file
    }
  },
});

/** The production io adapter, backed by Deno's filesystem. */
export const denoIo: Io = {
  readCatalogue: (corpusDir) =>
    readJson<CatalogueFile>(`${corpusDir}/catalogue/catalogue.json`),
  readDocument: (corpusDir, docKey) =>
    readJson<RawDoc>(`${corpusDir}/catalogue/documents/${docKey}.json`),
  readDictionary: (corpusDir) =>
    readJson<Dictionary>(`${corpusDir}/catalogue/dictionary.json`),
  scanCorpus,
  readManifest,
  readArtefacts,
  writeArtefacts,
  blockReader,
};
