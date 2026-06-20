/**
 * The imperative shell: the one module that touches the filesystem. Everything
 * below it is either pure (buildArtefacts, the codec in artefacts.ts, isFresh)
 * or reaches the disk only through a port defined here — a CorpusFs for the
 * corpus scan (whose file set is discovered by parsing) and a BlockReader for
 * lazy per-request block reads. The entry points construct `denoIo` and pass it
 * to the pipeline; tests pass an in-memory equivalent.
 *
 * Invariant: this is the only file in src/ that calls Deno's filesystem APIs.
 */

import type { CorpusFs } from "./build/catalog.ts";
import type { BlockReader } from "./serve/store.ts";
import {
  ARTEFACT_FILES,
  type ArtefactFiles,
  type CorpusScan,
  type Manifest,
} from "./artefacts.ts";

/** The filesystem capabilities the build and serve pipelines need. */
export interface Io {
  /** Corpus access for the catalog scan. */
  corpus: CorpusFs;
  /** Fingerprint the corpus: .mit file count and latest modification time. */
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

const denoCorpusFs: CorpusFs = {
  readFile: async (path) => {
    try {
      return await Deno.readTextFile(path);
    } catch {
      return null;
    }
  },
  readDir: async (path) => {
    const out: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(path)) out.push(entry);
    return out;
  },
  realPath: (path) => Deno.realPath(path),
  stat: async (path) => {
    try {
      return { isFile: (await Deno.stat(path)).isFile };
    } catch {
      return null;
    }
  },
};

const scanCorpus = async (corpusDir: string): Promise<CorpusScan> => {
  let files = 0;
  let modified = 0;
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile && entry.name.endsWith(".mit")) {
        files++;
        const info = await Deno.stat(path);
        modified = Math.max(modified, info.mtime?.getTime() ?? 0);
      }
    }
  };
  await walk(corpusDir);
  return { files, modified };
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
  corpus: denoCorpusFs,
  scanCorpus,
  readManifest,
  readArtefacts,
  writeArtefacts,
  blockReader,
};
