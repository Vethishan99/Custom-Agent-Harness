import chalk from "chalk";
import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";

// A line of the agent's reply, rendered as terminal Markdown.
export type Line = {
  text: string;
  // Inside a ``` code block: shown as-is, without Markdown.
  code: boolean;
  // The reply's first line, which carries the "Agent:" label.
  first: boolean;
  // A blank line came before this one. It is drawn as a margin rather than
  // as its own entry, because Ink drops output that is only a blank line.
  gap: boolean;
};

// Cuts streamed text into complete lines. Hides ``` fences, drops leading
// blank lines and collapses runs of blank lines into one gap.
export class LineSplitter {
  private partial = "";
  private inCode = false;
  private started = false;
  private pendingGap = false;

  push(text: string): Line[] {
    this.partial += text;
    const lines: Line[] = [];

    let newline: number;
    while ((newline = this.partial.indexOf("\n")) >= 0) {
      const line = this.partial.slice(0, newline).replace(/\r$/, "");
      this.partial = this.partial.slice(newline + 1);
      this.add(line, lines);
    }
    return lines;
  }

  // The line still being written, if there's anything to show.
  current(): Line | null {
    if (isFence(this.partial)) return null;
    if (!this.inCode && !this.partial.trim()) return null;
    return {
      text: this.partial,
      code: this.inCode,
      first: !this.started,
      gap: this.pendingGap,
    };
  }

  // Finish the reply: return the last partial line and reset.
  end(): Line[] {
    const lines: Line[] = [];
    if (this.partial) this.add(this.partial, lines);
    this.partial = "";
    this.inCode = false;
    this.started = false;
    this.pendingGap = false;
    return lines;
  }

  private add(text: string, lines: Line[]): void {
    if (isFence(text)) {
      this.inCode = !this.inCode;
      return;
    }
    if (!this.inCode && !text.trim()) {
      if (this.started) this.pendingGap = true;
      return;
    }
    lines.push({
      text,
      code: this.inCode,
      first: !this.started,
      gap: this.pendingGap,
    });
    this.started = true;
    this.pendingGap = false;
  }
}

function isFence(text: string): boolean {
  return /^\s*(```|~~~)/.test(text);
}

export type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
};

const INLINE =
  /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?![\s*])(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?![\s_])(.+?)(?<!\s)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

// Split a line into styled pieces: `code`, **bold**, *italic*, [links](url).
// Styles nest, so **`name`** is bold code.
export function inlineSpans(
  text: string,
  style: Omit<Span, "text"> = {},
): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ ...style, text: text.slice(last, index) });
    const [, code, bold1, bold2, italic1, italic2, linkText, url] = match;
    const bold = bold1 ?? bold2;
    const italic = italic1 ?? italic2;
    if (code !== undefined) spans.push({ ...style, text: code, code: true });
    else if (bold) spans.push(...inlineSpans(bold, { ...style, bold: true }));
    else if (italic) {
      spans.push(...inlineSpans(italic, { ...style, italic: true }));
    } else spans.push({ ...style, text: linkText!, link: url });
    last = index + match[0].length;
  }
  if (last < text.length) spans.push({ ...style, text: text.slice(last) });
  return spans;
}

// For a line still being typed: close an open `code` or **bold** span, so it
// shows styled as it types instead of as raw markers. A marker with nothing
// after it yet is hidden.
export function closeOpenMarkers(text: string): string {
  let out = text;
  if ((out.match(/`/g)?.length ?? 0) % 2 === 1) {
    out = out.endsWith("`") ? out.slice(0, -1) : `${out}\``;
  }
  const outsideCode = out.replace(/`[^`]*`/g, "");
  if ((outsideCode.match(/\*\*/g)?.length ?? 0) % 2 === 1) {
    out = out.endsWith("**") ? out.slice(0, -2) : `${out}**`;
  }
  return out;
}

// Inline Markdown as a terminal string with ANSI styles.
function styled(text: string): string {
  return inlineSpans(text)
    .map((span) => {
      let out = span.link
        ? `${chalk.underline(span.text)}${chalk.dim(` (${span.link})`)}`
        : span.text;
      if (span.code) out = chalk.cyan(out);
      if (span.bold) out = chalk.bold(out);
      if (span.italic) out = chalk.italic(out);
      return out;
    })
    .join("");
}

// Wrap here rather than leaving it to Ink, whose wrapping can push the space
// at a line break onto the start of the next line.
function wrap(text: string, width: number, trim = true): string {
  return wrapAnsi(text, Math.max(10, width), { hard: true, trim });
}

// One line of Markdown, wrapped to fit `width` columns.
export function MarkdownLine({
  text,
  code,
  width,
}: {
  text: string;
  code: boolean;
  width: number;
}) {
  if (code) {
    return (
      <Box>
        <Text dimColor>│ </Text>
        <Text>{wrap(chalk.yellow(text || " "), width - 2, false)}</Text>
      </Box>
    );
  }

  const heading = /^\s*#{1,6}\s+(.*)$/.exec(text);
  if (heading) {
    const title = heading[1].replace(/\s+#+\s*$/, "");
    return <Text>{wrap(chalk.bold.cyan(styled(title)), width)}</Text>;
  }

  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) {
    return <Text dimColor>{"─".repeat(Math.min(width, 40))}</Text>;
  }

  const quote = /^\s*>\s?(.*)$/.exec(text);
  if (quote) {
    return (
      <Box>
        <Text dimColor>│ </Text>
        <Text>{wrap(chalk.dim.italic(styled(quote[1])), width - 2)}</Text>
      </Box>
    );
  }

  // Lists get a hanging indent, so wrapped lines stay under their text.
  const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(text);
  if (item) {
    const [, indent, marker, rest] = item;
    const depth = Math.floor(indent.replace(/\t/g, "  ").length / 2);
    const bullet = /\d/.test(marker) ? marker : depth % 2 === 0 ? "•" : "◦";
    const used = depth * 2 + bullet.length + 1;
    return (
      <Box paddingLeft={depth * 2}>
        <Text color="green">{bullet} </Text>
        <Text>{wrap(styled(rest), width - used)}</Text>
      </Box>
    );
  }

  return <Text>{wrap(styled(text), width)}</Text>;
}
