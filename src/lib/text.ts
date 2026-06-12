/**
 * Plain-text extraction from compiled Markit structures, used for the
 * search index and for diffing editions. Page breaks contribute nothing
 * (they can fall mid-word), footnote references are dropped, and explicit
 * spacing elements become ordinary spaces.
 */

import type {
  Block,
  BlockElement,
  InlineElement,
  List,
  MarkitDocument,
} from "@earlytexts/markit";

export const inlineText = (elements: InlineElement[]): string =>
  elements.map((el) => {
    switch (el.type) {
      case "plainText":
        return el.content;
      case "lineBreak":
        return "\n";
      case "emSpace":
      case "nbSpace":
        return " ";
      case "illegible":
        return "[...]";
      case "footnoteReference":
      case "pageBreak":
        return "";
      default:
        return "content" in el ? inlineText(el.content) : "";
    }
  }).join("");

const listText = (list: List): string =>
  list.items.map((item) =>
    inlineText(item.content) +
    (item.nestedList === undefined ? "" : "\n" + listText(item.nestedList))
  ).join("\n");

export const elementText = (element: BlockElement): string => {
  switch (element.type) {
    case "heading":
      return element.content.map((line) => inlineText(line.content)).join(
        "\n",
      );
    case "paragraph":
      return inlineText(element.content);
    case "blockquote":
      return element.content.map((p) => inlineText(p.content)).join("\n");
    case "list":
      return listText(element);
    case "table":
      return element.rows.map((row) =>
        row.cells.map((cell) => inlineText(cell.content)).join(" | ")
      ).join("\n");
  }
};

export const blockText = (block: Block): string =>
  block.content.map(elementText).join("\n");

/** Full text of a document, including all (inline) children, recursively. */
export const documentText = (doc: MarkitDocument): string =>
  [
    ...doc.blocks.map(blockText),
    ...doc.children.map(documentText),
  ].join("\n\n");
