/**
 * The document-term matrix artefact (item 2 of the roadmap): the TF-IDF
 * substrate the similarity and topic routes will read. No route consumes it yet,
 * so it is exercised at the artefact level — the in-memory build output, and the
 * codec round-trip through the serialized files (parseDtm) — pinning the shape
 * the vector work depends on: rows are (edition, section) documents, columns are
 * lemmas, and every row is an L2-normalised sparse vector in CSR form.
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { DTM_BIN, DTM_JSON, parseDtm } from "../../src/core/artefacts.ts";
import { testData } from "../helpers.ts";

Deno.test("the DTM has one row per (edition, section) document", async () => {
  const { built } = await testData();
  const { dtm, units } = { dtm: built.dtm, units: built.units };

  const docKeys = new Set<string>();
  for (let u = 0; u < units.edition.length; u++) {
    docKeys.add(`${units.edition[u]}\t${units.sectionPath[u]}`);
  }
  assertEquals(dtm.docs.length, docKeys.size);
  // Every document row addresses a real (edition, section) pair from the units.
  for (const doc of dtm.docs) {
    assert(docKeys.has(`${doc.edition}\t${doc.sectionPath}`));
  }
});

Deno.test("CSR rows are well-formed and L2-normalised over lemma columns", async () => {
  const { built } = await testData();
  const { dtm } = built;

  assertEquals(dtm.rowPtr.length, dtm.docs.length + 1);
  assertEquals(dtm.rowPtr[0], 0);
  assertEquals(dtm.rowPtr[dtm.rowPtr.length - 1], dtm.cols.length);
  assertEquals(dtm.cols.length, dtm.vals.length);

  for (let d = 0; d < dtm.docs.length; d++) {
    let prevCol = -1;
    let sumSquares = 0;
    for (let i = dtm.rowPtr[d]; i < dtm.rowPtr[d + 1]; i++) {
      assert(dtm.cols[i] > prevCol, "columns ascending within a row");
      assert(dtm.cols[i] < dtm.lemmas.length, "column is a lemma id");
      prevCol = dtm.cols[i];
      sumSquares += dtm.vals[i] * dtm.vals[i];
    }
    // A row is either a unit vector or empty (a section of only empty blocks).
    if (dtm.rowPtr[d] !== dtm.rowPtr[d + 1]) {
      assertAlmostEquals(sumSquares, 1, 1e-5);
    }
  }
});

Deno.test("columns are citation-form lemmas of the edited text", async () => {
  const { built } = await testData();
  const { dtm, vocab } = built;
  const lemmaSet = new Set(
    vocab.readings.flatMap((readings) =>
      readings.flatMap((reading) => reading.map((word) => word.lemma))
    ),
  );
  for (const lemma of dtm.lemmas) assert(lemmaSet.has(lemma));
  // "passions" collapses to its citation form, "connexion" normalises spelling.
  assert(dtm.lemmas.includes("passion"));
  assert(dtm.lemmas.includes("connection"));
});

Deno.test("the DTM round-trips through its serialized files", async () => {
  const { built, files } = await testData();
  const restored = parseDtm(files.get(DTM_JSON)!, files.get(DTM_BIN)!);
  assertEquals(restored.docs, built.dtm.docs);
  assertEquals(restored.lemmas, built.dtm.lemmas);
  assertEquals(restored.rowPtr, built.dtm.rowPtr);
  assertEquals(restored.cols, built.dtm.cols);
  assertEquals(restored.vals, built.dtm.vals);
});
