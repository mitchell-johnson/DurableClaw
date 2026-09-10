/** Portable slidey parser/renderer derived from gogcli internal/slidesmarkdown
 * and slides_layout.go. Asset renderers are optional upstream executables. */
import { marked } from "marked";
import type { Data } from "./types";
import { markdownPlan } from "./documents-docs-core";
import { textStyle, pt, uuid, color, mask } from "./documents-common";
export interface SlideySlide {
  body: string;
  notes: string;
  frontmatter: Record<string, string>;
}
export function parseSlidey(source: string): SlideySlide[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n"),
    slides: SlideySlide[] = [];
  let i = 0;
  const delimiter = (line: string) => line.trim() === "---";
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    const frontmatter: Record<string, string> = {};
    if (i < lines.length && delimiter(lines[i])) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      let close = next;
      while (
        close < lines.length &&
        /^[A-Za-z_][\w-]*:\s/.test(lines[close].trim())
      )
        close++;
      if (close > next && close < lines.length && delimiter(lines[close])) {
        for (const line of lines.slice(next, close)) {
          const at = line.indexOf(":"),
            key = line.slice(0, at).trim(),
            raw = line.slice(at + 1).trim();
          let value = raw;
          if (raw.startsWith('"')) {
            try {
              value = JSON.parse(raw);
            } catch {
              throw new Error("Invalid quoted slide frontmatter");
            }
          } else if (raw.startsWith("'")) {
            if (!raw.endsWith("'"))
              throw new Error("Invalid quoted slide frontmatter");
            value = raw.slice(1, -1).replaceAll("''", "'");
          }
          frontmatter[key] = value;
        }
        i = close + 1;
      } else i++;
    }
    const body: string[] = [],
      notes: string[] = [];
    let fence = "",
      fenceLength = 0,
      inNotes = false;
    while (i < lines.length) {
      const line = lines[i],
        trimmed = line.trim();
      if (!fence && delimiter(line)) break;
      const marker = /^(`{3,}|~{3,})/.exec(trimmed);
      if (marker) {
        if (!fence) {
          fence = marker[1][0];
          fenceLength = marker[1].length;
        } else if (
          marker[1][0] === fence &&
          marker[1].length >= fenceLength &&
          trimmed.slice(marker[1].length).trim() === ""
        )
          fence = "";
      }
      if (!fence && (trimmed === "## Notes" || trimmed === "### Notes"))
        inNotes = true;
      else (inNotes ? notes : body).push(line);
      i++;
    }
    if (body.join("\n").trim())
      slides.push({
        body: body.join("\n"),
        notes: notes
          .join("\n")
          .trim()
          .replace(/:fa[srlbd]?-[a-z0-9][a-z0-9-]*:/g, ""),
        frontmatter,
      });
  }
  return slides;
}
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const properties = (page: string, b: Box) => ({
  pageObjectId: page,
  size: { width: pt(b.width), height: pt(b.height) },
  transform: {
    scaleX: 1,
    scaleY: 1,
    translateX: b.x,
    translateY: b.y,
    unit: "PT",
  },
});
export function renderSlidey(
  source: string,
  f: Data,
): {
  requests: Data[];
  speakerNotes: { pageId: string; text: string }[];
  warnings: string[];
  slides: number;
  frontmatter: Record<string, string>[];
} {
  const slides = parseSlidey(source);
  if (!slides.length) throw new Error("No slides found in Markdown");
  const requests: Data[] = [],
    speakerNotes: { pageId: string; text: string }[] = [],
    warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const stripIcons = (text: string) =>
    text.replace(/:fa([srlbd])?-([a-z0-9][a-z0-9-]*):/g, (_, prefix, name) => {
      const style =
        (
          {
            s: "solid",
            r: "regular",
            b: "brands",
            l: "solid",
            d: "solid",
          } as Data
        )[prefix] ??
        f["fa-style"] ??
        "solid";
      warn(
        `Skipping Font Awesome ${style} icon ${name}: the optional SVG rasterizer is unavailable in the Durable Object runtime.`,
      );
      return "";
    });
  const textBox = (
    page: string,
    b: Box,
    source: string,
    baseSize = 18,
    center = false,
    shape = "TEXT_BOX",
  ) => {
    const plan = markdownPlan(stripIcons(source)),
      objectId = uuid("text");
    let text = plan.text;
    // Images and tables are laid out as native objects by renderBlocks, below.
    if (plan.specials.length)
      throw new Error(
        "Nested structural content requires its own Markdown block",
      );
    if (!text) return;
    requests.push(
      {
        createShape: {
          objectId,
          shapeType: shape,
          elementProperties: properties(page, b),
        },
      },
      { insertText: { objectId, text, insertionIndex: 0 } },
      {
        updateTextStyle: {
          objectId,
          textRange: { type: "ALL" },
          style: { fontSize: pt(baseSize) },
          fields: "fontSize",
        },
      },
    );
    if (center)
      requests.push({
        updateParagraphStyle: {
          objectId,
          textRange: { type: "ALL" },
          style: { alignment: "CENTER" },
          fields: "alignment",
        },
      });
    const bullets: typeof plan.styles = [];
    for (const span of plan.styles) {
      const range = {
          type: "FIXED_RANGE",
          startIndex: span.start,
          endIndex: span.end,
        },
        style = textStyle(span.flags, true);
      if (span.flags["heading-level"]) {
        style.fontSize = pt(
          Math.max(18, 32 - Number(span.flags["heading-level"]) * 2),
        );
        style.bold = true;
      }
      if (Object.keys(style).length)
        requests.push({
          updateTextStyle: {
            objectId,
            textRange: range,
            style,
            fields: mask(style),
          },
        });
      if (
        span.flags.bullets ||
        span.flags.ordered ||
        span.flags["bullet-preset"]
      )
        bullets.push(span);
      if (span.flags["indent-start"])
        requests.push({
          updateParagraphStyle: {
            objectId,
            textRange: range,
            style: { indentStart: pt(span.flags["indent-start"]) },
            fields: "indentStart",
          },
        });
    }
    for (const span of bullets.sort((a, b) => b.start - a.start))
      requests.push({
        createParagraphBullets: {
          objectId,
          textRange: {
            type: "FIXED_RANGE",
            startIndex: span.start,
            endIndex: span.end,
          },
          bulletPreset: span.flags.ordered
            ? "NUMBERED_DIGIT_ALPHA_ROMAN"
            : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
  };
  const renderBlocks = (
    page: string,
    source: string,
    b: Box,
    baseSize = 18,
    center = false,
  ) => {
    const tokens = marked.lexer(source) as Data[],
      blocks = tokens.filter((t) => t.type !== "space");
    const count = Math.max(blocks.length, 1);
    let y = b.y;
    const height = b.height / count;
    for (const token of blocks) {
      const rect = { ...b, y, height: Math.max(20, height - 6) };
      y += height;
      if (token.type === "code" && String(token.lang).trim() === "mermaid") {
        warn(
          "Skipping Mermaid diagram: the optional mmdc executable is unavailable in the Durable Object runtime.",
        );
        continue;
      }
      if (token.type === "hr") {
        const objectId = uuid("rule");
        requests.push({
          createLine: {
            objectId,
            lineCategory: "STRAIGHT",
            elementProperties: properties(page, { ...rect, height: 1 }),
          },
        });
        continue;
      }
      if (token.type === "table") {
        const rows = [token.header, ...token.rows] as Data[][],
          objectId = uuid("table"),
          columns = token.header.length;
        requests.push({
          createTable: {
            objectId,
            rows: rows.length,
            columns,
            elementProperties: properties(page, rect),
          },
        });
        rows.forEach((row, rowIndex) =>
          row.forEach((cell, columnIndex) => {
            const plan = markdownPlan(stripIcons(cell.text));
            if (plan.specials.length)
              throw new Error(
                "Table cells must contain text formatting, not structural objects",
              );
            const text = plan.text.replace(/\n$/, "");
            if (!text) return;
            const cellLocation = { rowIndex, columnIndex };
            requests.push({
              insertText: { objectId, cellLocation, text, insertionIndex: 0 },
            });
            if (rowIndex === 0)
              requests.push({
                updateTextStyle: {
                  objectId,
                  cellLocation,
                  textRange: { type: "ALL" },
                  style: { bold: true },
                  fields: "bold",
                },
              });
            for (const span of plan.styles) {
              const style = textStyle(span.flags, true);
              if (Object.keys(style).length)
                requests.push({
                  updateTextStyle: {
                    objectId,
                    cellLocation,
                    textRange: {
                      type: "FIXED_RANGE",
                      startIndex: span.start,
                      endIndex: Math.min(text.length, span.end),
                    },
                    style,
                    fields: mask(style),
                  },
                });
            }
          }),
        );
        continue;
      }
      const plan = markdownPlan(token.raw ?? token.text ?? "");
      if (plan.specials.some((s) => s.kind === "image")) {
        const images = plan.specials.filter((s) => s.kind === "image");
        images.forEach((image, index) => {
          const url = new URL(image.value.url);
          if (url.protocol !== "https:" || url.username || url.password)
            throw new Error("Public HTTPS image URL required");
          requests.push({
            createImage: {
              objectId: uuid("image"),
              url: url.href,
              elementProperties: properties(page, {
                ...rect,
                x: rect.x + (index * rect.width) / images.length,
                width: rect.width / images.length,
              }),
            },
          });
        });
        const remaining = plan.text.replaceAll("\ufffc", "").trim();
        if (remaining)
          textBox(
            page,
            {
              ...rect,
              y: rect.y + rect.height * 0.75,
              height: rect.height * 0.25,
            },
            remaining,
            Math.min(baseSize, 14),
            center,
          );
      } else
        textBox(page, rect, token.raw ?? token.text ?? "", baseSize, center);
    }
  };
  for (const slide of slides) {
    const pageId = uuid("slide"),
      layout = slide.frontmatter.layout ?? "",
      section = ["title", "hero", "statement"].includes(layout),
      center = section || layout === "center";
    requests.push({
      createSlide: {
        objectId: pageId,
        slideLayoutReference: { predefinedLayout: "BLANK" },
      },
    });
    let body = slide.body,
      bodyTop = 36;
    if (!section) {
      const tokens = marked.lexer(body) as Data[],
        title =
          tokens.find((t) => t.type === "heading" && t.depth === 1) ??
          tokens.find((t) => t.type === "heading" && t.depth === 2);
      if (title) {
        textBox(
          pageId,
          { x: 36, y: 26, width: 648, height: 65 },
          title.raw,
          28,
          center,
        );
        body = body.replace(title.raw, "");
        bodyTop = 100;
      }
    }
    const noteComment =
      /<!--\s*(?:notes|speaker notes)\s*:\s*([\s\S]*?)-->/i.exec(body);
    if (noteComment) body = body.replace(noteComment[0], "");
    const noteText = slide.notes || noteComment?.[1].trim();
    if (noteText && !f["no-notes"])
      speakerNotes.push({ pageId, text: noteText });
    const lines = body.split("\n"),
      first = lines.findIndex((line) => line.trim() === "::cols::");
    let cols: string[] = [];
    if (first >= 0) {
      const last = lines.findIndex(
        (line, i) => i > first && line.trim() === "::/cols::",
      );
      if (last < 0) throw new Error("Unclosed ::cols:: block");
      const inner = lines.slice(first + 1, last).join("\n");
      cols = inner.split(/^\s*::(?:col[23]|right)::\s*$/m);
      const before = lines.slice(0, first).join("\n"),
        after = lines.slice(last + 1).join("\n");
      if (before.trim())
        renderBlocks(pageId, before, {
          x: 36,
          y: bodyTop,
          width: 648,
          height: 45,
        });
      if (after.trim())
        renderBlocks(pageId, after, { x: 36, y: 340, width: 648, height: 35 });
    } else if (["two-cols", "three-cols"].includes(layout))
      cols = body.split(/^\s*::(?:col[23]|right)::\s*$/m);
    if (cols.length) {
      const count = layout === "three-cols" ? 3 : Math.max(cols.length, 2);
      if (cols.length > count) throw new Error("Too many column markers");
      const width = (648 - 18 * (count - 1)) / count;
      cols.forEach((column, i) =>
        renderBlocks(
          pageId,
          column,
          {
            x: 36 + i * (width + 18),
            y: bodyTop + (first > 0 ? 50 : 0),
            width,
            height: 305 - (bodyTop - 36) - (first > 0 ? 50 : 0),
          },
          18,
          false,
        ),
      );
    } else if (/^\s*::(?:boxes|arrows)::\s*$/m.test(body)) {
      const open = /^\s*::(boxes|arrows)::\s*$/m.exec(body)!,
        end = `::/${open[1]}::`,
        closing = body.indexOf(end, open.index);
      if (closing < 0) throw new Error(`Unclosed ${open[0].trim()} block`);
      const rows = body
          .slice(open.index + open[0].length, closing)
          .split("\n")
          .map((line) => line.trim().replace(/^[-*]\s*/, ""))
          .filter(Boolean),
        width =
          (648 - 12 * Math.max(0, rows.length - 1)) / Math.max(rows.length, 1);
      rows.forEach((row, i) => {
        textBox(
          pageId,
          { x: 36 + i * (width + 12), y: bodyTop + 50, width, height: 180 },
          row,
          18,
          true,
          open[1] === "arrows" ? "RIGHT_ARROW" : "ROUND_RECTANGLE",
        );
      });
      const before = body.slice(0, open.index),
        after = body.slice(closing + end.length);
      if (before.trim())
        renderBlocks(pageId, before, {
          x: 36,
          y: bodyTop,
          width: 648,
          height: 45,
        });
      if (after.trim())
        renderBlocks(pageId, after, { x: 36, y: 340, width: 648, height: 35 });
    } else
      renderBlocks(
        pageId,
        body,
        {
          x: 36,
          y: section ? 105 : bodyTop,
          width: 648,
          height: section ? 195 : 369 - bodyTop,
        },
        section ? 30 : 18,
        center,
      );
  }
  if (f.strict && warnings.length) throw new Error(warnings.join(" "));
  if (requests.length > 2000)
    throw new Error(
      "Markdown deck exceeds the 2000-operation limit; split the input",
    );
  return {
    requests,
    speakerNotes,
    warnings,
    slides: slides.length,
    frontmatter: slides.map((s) => s.frontmatter),
  };
}
