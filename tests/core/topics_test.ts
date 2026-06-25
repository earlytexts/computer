/**
 * The topic model (item 4 of the roadmap): an NMF factorisation of the DTM,
 * trained at build time and read back by two routes. The artefact-level tests
 * pin the model's shape (a mix per document summing to 1, topic-term rows of
 * real lemmas) and its determinism; the route tests pin the wire contract of
 * `/topics` (the model — terms and prominent works) and `/topics/mix` (a
 * target's mix, with the same level resolution as `/similar`).
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { buildTopics } from "../../src/core/build/builder.ts";
import {
  parseTopics,
  TOPICS_BIN,
  TOPICS_JSON,
} from "../../src/core/artefacts.ts";
import { testComputer, testData } from "../helpers.ts";

Deno.test("the model has one mix row per DTM document, each summing to 1 or 0", async () => {
  const { built } = await testData();
  const { topics, dtm } = built;

  assertEquals(topics.docs, dtm.docs); // rows are the DTM documents, in order
  assert(topics.k >= 1);
  assertEquals(topics.mix.length, topics.docs.length * topics.k);
  assertEquals(topics.terms.length, topics.k);

  for (let d = 0; d < topics.docs.length; d++) {
    let sum = 0;
    for (let t = 0; t < topics.k; t++) {
      const w = topics.mix[d * topics.k + t];
      assert(w >= 0, "mix weights are non-negative");
      sum += w;
    }
    // A document is either a mix over topics (sum 1) or empty (no indexed text).
    if (sum !== 0) assertAlmostEquals(sum, 1, 1e-5);
  }
});

Deno.test("topic-term rows are real lemmas with descending positive weights", async () => {
  const { built } = await testData();
  const { topics, dtm } = built;
  const lemmaSet = new Set(dtm.lemmas);

  for (const terms of topics.terms) {
    let prev = Infinity;
    for (const { lemma, weight } of terms) {
      assert(lemmaSet.has(lemma), `${lemma} is a DTM lemma`);
      assert(weight > 0 && weight <= 1, `weight in (0,1]: ${weight}`);
      assert(weight <= prev, "terms descend by weight");
      prev = weight;
    }
  }
});

Deno.test("training is deterministic and round-trips through its files", async () => {
  const { built, files } = await testData();
  // The seeded NMF gives the same factors on a re-run from the same DTM.
  const again = buildTopics(built.dtm);
  assertEquals(again.k, built.topics.k);
  assertEquals(again.terms, built.topics.terms);
  assertEquals(again.mix, built.topics.mix);

  // And the serialized artefact reconstructs the in-memory model.
  const restored = parseTopics(files.get(TOPICS_JSON)!, files.get(TOPICS_BIN)!);
  assertEquals(restored.k, built.topics.k);
  assertEquals(restored.docs, built.topics.docs);
  assertEquals(restored.terms, built.topics.terms);
  assertEquals(restored.mix, built.topics.mix);
});

Deno.test("computer.topics returns the model: terms and prominent works", async () => {
  const computer = await testComputer();
  const response = await computer.topics({ terms: 5, works: 3 });
  assert(response.k >= 1);
  assertEquals(response.topics.length, response.k);

  const slugs = new Set<string>();
  response.topics.forEach((topic, index) => {
    assertEquals(topic.id, index);
    assert(topic.label.length > 0);
    assert(topic.terms.length <= 5);
    assert(topic.prominent.length <= 3);
    for (const work of topic.prominent) {
      assert(work.weight > 0 && work.weight <= 1);
      slugs.add(`${work.authors[0]}/${work.work}`);
    }
    // Prominent works descend by weight.
    for (let i = 1; i < topic.prominent.length; i++) {
      assert(topic.prominent[i - 1].weight >= topic.prominent[i].weight);
    }
  });
  // Prominent works are drawn from the corpus's works.
  assert(slugs.size > 0);
});

Deno.test("computer.topicMix gives a target's mix at each level", async () => {
  const computer = await testComputer();

  // Section level inferred from the path; the canonical edition resolved.
  const section = await computer.topicMix({
    author: "test",
    work: "tw",
    path: ["1"],
  });
  assertEquals(section.level, "section");
  assertEquals(section.edition, "1760");
  assertEquals(section.sectionPath, ["1"]);
  assert(section.found);
  // Weights descend and are shares in (0, 1].
  for (let i = 0; i < section.topics.length; i++) {
    const w = section.topics[i].weight;
    assert(w > 0 && w <= 1);
    if (i > 0) assert(section.topics[i - 1].weight >= w);
  }

  // The whole work, with the limit lifted: the mix is a full distribution.
  const work = await computer.topicMix({
    author: "test",
    work: "tw",
    level: "work",
    limit: 100,
  });
  assertEquals(work.level, "work");
  assertEquals(work.edition, null);
  assert(work.found);
  const total = work.topics.reduce((n, topic) => n + topic.weight, 0);
  assertAlmostEquals(total, 1, 0.01);
});

Deno.test("computer.topicMix reports not-found for an unknown target", async () => {
  const computer = await testComputer();
  const missing = await computer.topicMix({ author: "test", work: "nope" });
  assert(!missing.found);
  assertEquals(missing.topics.length, 0);
  assertEquals(missing.total, 0);
});
