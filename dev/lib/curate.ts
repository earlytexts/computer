/**
 * The interactive review loop shared by the variants and lemmas tools. It
 * walks the corpus surfaces (commonest first), shows how the computer treats
 * each one, and offers: confirm (Enter), edit (write an override), skip, or
 * quit. Counts of accounted/remaining are shown at every step. Line-based
 * prompts (not raw keypresses) so it behaves over any terminal, incl. remote.
 */

import { bold, dim, green, n, yellow } from "./term.ts";
import { loadProgress, type Progress, saveProgress } from "./progress.ts";

export type Curator = {
  /** "variants" | "lemmas" — used in headings and the summary. */
  toolName: string;
  surfaces: string[];
  cf: number[];
  df: number[];
  /** surface indices in review order (commonest first). */
  order: number[];
  /**
   * The display-ready, already-styled status line for surface i (the line
   * under the surface/frequency line). Reflects this session's edits. Each
   * tool formats its own — the variant mapping + search group, the lemma +
   * its inflectional family — so the loop stays presentation-agnostic.
   */
  statusLine: (i: number) => string;
  /** noun for the edited thing: "modern spelling" / "lemma". */
  editNoun: string;
  /** persist an override for surface i; value is trimmed, non-empty, no spaces. */
  applyEdit: (i: number, value: string) => Promise<void>;
  /** whether surface i currently has an override (read live). */
  isModified: (i: number) => boolean;
  /** path of the override file, for the heading. */
  overrideRelPath: string;
  progressPath: string;
  builtAt: string;
};

export const runCuration = async (c: Curator): Promise<void> => {
  const progress: Progress = await loadProgress(c.progressPath);
  const rebuilt = progress.builtAt !== "" && progress.builtAt !== c.builtAt;
  progress.builtAt = c.builtAt;

  const confirmed = new Set(progress.confirmed);
  const skipped = new Set(progress.skipped);
  const total = c.surfaces.length;

  const accountedOf = (i: number): boolean =>
    c.isModified(i) || confirmed.has(c.surfaces[i]);

  const accountedCount = (): number => {
    let count = 0;
    for (let i = 0; i < total; i++) if (accountedOf(i)) count++;
    return count;
  };

  const persist = async (): Promise<void> => {
    progress.confirmed = [...confirmed];
    progress.skipped = [...skipped];
    await saveProgress(c.progressPath, progress);
  };

  // Everything not yet accounted, fresh items before previously-skipped ones.
  const pending = c.order.filter((i) => !accountedOf(i));
  const queue = [
    ...pending.filter((i) => !skipped.has(c.surfaces[i])),
    ...pending.filter((i) => skipped.has(c.surfaces[i])),
  ];

  console.log(bold(`\n${c.toolName} curation`));
  console.log(dim(`overrides → ${c.overrideRelPath}`));
  console.log(dim(`edits take effect on the next \`deno task build\``));
  if (rebuilt) {
    console.log(
      yellow(
        "corpus rebuilt since last session; progress re-counted against the new vocabulary",
      ),
    );
  }

  for (const i of queue) {
    const surface = c.surfaces[i];
    const accounted = accountedCount();
    const pct = ((accounted / total) * 100).toFixed(1);

    console.log("");
    console.log(dim("─".repeat(64)));
    console.log(
      `${bold(c.toolName)} · ${n(accounted)} / ${n(total)} accounted ` +
        `(${pct}%) · ${n(total - accounted)} remaining · ${
          n(skipped.size)
        } skipped`,
    );
    console.log("");
    console.log(
      `  ${bold(surface)}   ${dim(`×${n(c.cf[i])} · ${n(c.df[i])} docs`)}`,
    );
    console.log(`  ${c.statusLine(i)}`);
    console.log(
      dim(`  [Enter] confirm   e ${c.editNoun}   s skip   q save & quit`),
    );

    const raw = prompt("  ›");
    if (raw === null) break; // EOF / non-interactive
    const ans = raw.trim();
    const cmd = ans.toLowerCase();

    if (cmd === "q") break;

    if (cmd === "s") {
      skipped.add(surface);
      await persist();
      continue;
    }

    if (cmd === "e" || cmd.startsWith("e ")) {
      const inline = ans.slice(1).trim();
      const value = (inline ||
        prompt(`  ${c.editNoun} for “${surface}” ›`)?.trim() || "")
        .toLowerCase();
      if (value === "") {
        console.log(yellow("  (empty — left unaccounted)"));
        continue;
      }
      if (/\s/.test(value)) {
        console.log(yellow("  (must be a single word — not applied)"));
        continue;
      }
      await c.applyEdit(i, value);
      skipped.delete(surface);
      confirmed.delete(surface);
      await persist();
      console.log(green(`  ✓ ${surface} → ${value}`));
      console.log(`  ${c.statusLine(i)}`);
      continue;
    }

    // Anything else (incl. bare Enter): confirm as-is.
    confirmed.add(surface);
    skipped.delete(surface);
    await persist();
    console.log(green("  ✓ confirmed"));
  }

  const accounted = accountedCount();
  const pct = ((accounted / total) * 100).toFixed(1);
  console.log("");
  console.log(
    bold(
      `${n(accounted)} / ${n(total)} accounted (${pct}%) · ` +
        `${n(total - accounted)} remaining · ${n(skipped.size)} skipped.`,
    ),
  );
  console.log(dim("Run again to resume where you left off."));
};
