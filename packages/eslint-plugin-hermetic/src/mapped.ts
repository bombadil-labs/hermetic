/** A piece of output: copied from the source at `from`, or new text that stands for the source at `from`. */
interface Run {
  readonly text: string;
  readonly from: number;
  readonly copied: boolean;
}

/**
 * Text assembled from pieces of a source, which remembers where each piece
 * came from, so that a rewrite can return a source map with its result.
 */
export class Mapped {
  readonly runs: readonly Run[];
  #text: string | undefined;

  private constructor(runs: readonly Run[]) {
    this.runs = runs;
  }

  static readonly empty: Mapped = new Mapped([]);

  /** The source's text in `range`. */
  static copy(source: string, [start, end]: readonly [number, number]): Mapped {
    return new Mapped(start < end ? [{ text: source.slice(start, end), from: start, copied: true }] : []);
  }

  /** New text, which stands for the source at `at`. */
  static place(text: string, at: number): Mapped {
    return new Mapped(text ? [{ text, from: at, copied: false }] : []);
  }

  static join(parts: readonly Mapped[]): Mapped {
    return new Mapped(parts.flatMap((part) => part.runs));
  }

  get text(): string {
    this.#text ??= this.runs.map((run) => run.text).join("");
    return this.#text;
  }

  /** The text from `start` to `end`, as offsets into this text. */
  slice(start: number, end: number): Mapped {
    const runs: Run[] = [];
    let offset = 0;
    for (const run of this.runs) {
      const from = Math.max(start - offset, 0);
      const to = Math.min(end - offset, run.text.length);
      if (from < to) runs.push({ ...run, text: run.text.slice(from, to), from: run.copied ? run.from + from : run.from });
      offset += run.text.length;
    }
    return new Mapped(runs);
  }

  trim(): Mapped {
    const start = this.text.length - this.text.trimStart().length;
    return this.slice(start, Math.max(start, this.text.trimEnd().length));
  }
}

/**
 * A template tag that joins mapped text with plain text, where the plain text
 * stands for the source at `at`.
 */
export function mappedAt(at: number) {
  return (strings: TemplateStringsArray, ...values: readonly (Mapped | string)[]): Mapped =>
    Mapped.join(
      strings.flatMap((string, index) => {
        const value = values[index];
        const parts = [Mapped.place(string, at)];
        if (value !== undefined) parts.push(typeof value === "string" ? Mapped.place(value, at) : value);
        return parts;
      }),
    );
}

/** A replacement of the text in `range`. An empty range inserts; new text stands for the start of the range. */
export interface MappedEdit {
  readonly range: readonly [number, number];
  readonly text: string | Mapped;
}

/** The source between `start` and `end`, with the edits inside that span applied. */
export function compose(source: string, [start, end]: readonly [number, number], edits: readonly MappedEdit[]): Mapped {
  const parts: Mapped[] = [];
  let at = start;
  const inside = edits.filter((edit) => edit.range[0] >= start && edit.range[1] <= end);
  // Insertions sort before replacements that start at the same offset.
  for (const edit of inside.sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1])) {
    parts.push(Mapped.copy(source, [at, edit.range[0]]));
    parts.push(typeof edit.text === "string" ? Mapped.place(edit.text, edit.range[0]) : edit.text);
    at = edit.range[1];
  }
  parts.push(Mapped.copy(source, [at, end]));
  return Mapped.join(parts);
}

/** A version 3 source map, in the shape bundlers accept from a transform. */
export interface SourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

/**
 * A source map from `mapped`'s text back to `source`. Copied text is mapped at
 * the start of each word, and at each character that is neither part of a word
 * nor a space, much as magic-string's `hires: "boundary"` maps it. New text is
 * mapped to the place it stands for, where it starts and where each of its
 * lines starts.
 */
export function sourceMap(mapped: Mapped, source: string, filename: string): SourceMap {
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) lineStarts.push(index + 1);
  const locate = (offset: number): readonly [number, number] => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return [low, offset - (lineStarts[low] ?? 0)];
  };

  const lines: string[] = [];
  let segments: string[] = [];
  let column = 0;
  // Each field is relative to the one before it: the column within a line, the rest across lines.
  const last = { column: 0, line: 0, sourceColumn: 0 };
  const mapTo = (offset: number): void => {
    const [line, sourceColumn] = locate(offset);
    segments.push(`${vlq(column - last.column)}A${vlq(line - last.line)}${vlq(sourceColumn - last.sourceColumn)}`);
    Object.assign(last, { column, line, sourceColumn });
  };
  for (const run of mapped.runs) {
    for (let index = 0; index < run.text.length; index++) {
      const char = run.text[index] ?? "";
      if (char === "\n") {
        lines.push(segments.join(","));
        segments = [];
        column = 0;
        last.column = 0;
        continue;
      }
      const previous = run.text[index - 1];
      if (previous === undefined || previous === "\n" || (run.copied && startsToken(char, previous))) {
        mapTo(run.copied ? run.from + index : run.from);
      }
      column++;
    }
  }
  lines.push(segments.join(","));
  return { version: 3, file: filename, sources: [filename], sourcesContent: [source], names: [], mappings: lines.join(";") };
}

const WORD = /[\w$]/;
const SPACE = /\s/;

/** A word starts at `char`, or `char` is punctuation or an operator. */
function startsToken(char: string, previous: string): boolean {
  return !SPACE.test(char) && !(WORD.test(char) && WORD.test(previous));
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A number in a source map's base64 VLQ: sign in the lowest bit, five bits per digit, low digits first. */
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let digits = "";
  do {
    const digit = rest & 31;
    rest >>>= 5;
    digits += BASE64[rest > 0 ? digit | 32 : digit];
  } while (rest > 0);
  return digits;
}
