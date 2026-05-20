// CSV / TSV parser. RFC 4180-flavoured:
//   * fields can be quoted with `"`; quoted fields may contain the
//     separator, CRLF, or LF
//   * `""` inside a quoted field decodes to a single `"`
//   * the configurable separator picks CSV (`,`) vs TSV (`\t`)
//   * row terminators are LF or CRLF; bare CR (legacy Mac line endings) is
//     ignored outside fields
//   * BOM stripping is the caller's job (CsvStream handles it)
//
// Two entry points share one underlying state machine:
//   * `parseCsvText` — sync, for unit tests and small whole-file parses
//   * `CsvStream`    — async ReadableStream wrapper, mirrors JsonlStream so
//                      the Rows view can stream without buffering the whole
//                      file

type State = 'field-start' | 'in-field' | 'in-quoted' | 'after-quote'

/// Underlying state machine. Stateful so chunks can flow through across
/// async reads — feeding the same parser with successive substrings yields
/// the same row sequence as feeding it with the whole concatenated text.
export class CsvParser {
  private state: State = 'field-start'
  private field = ''
  private row: string[] = []
  private errCount = 0
  private readonly separator: string

  constructor(separator: string) {
    this.separator = separator
  }

  /// Feed text and invoke `onRow` for each complete row encountered.
  feed(text: string, onRow: (row: string[]) => void): void {
    for (let i = 0; i < text.length; i++) {
      this.consume(text[i]!, onRow)
    }
  }

  /// Flush the partial row at EOF. Unclosed quotes count as one error; the
  /// half-built field is still emitted so users see whatever made it
  /// through.
  end(onRow: (row: string[]) => void): void {
    if (this.state === 'in-quoted') this.errCount++
    if (this.state !== 'field-start' || this.row.length > 0) {
      this.row.push(this.field)
      onRow(this.row)
      this.field = ''
      this.row = []
      this.state = 'field-start'
    }
  }

  get errors(): number {
    return this.errCount
  }

  private consume(c: string, onRow: (row: string[]) => void): void {
    switch (this.state) {
      case 'field-start':
        if (c === '"') {
          this.state = 'in-quoted'
        } else if (c === this.separator) {
          this.row.push('')
        } else if (c === '\n') {
          // A `\n` at field-start with nothing accumulated = blank line;
          // skip so trailing newlines and blank gaps don't produce phantom
          // empty rows. With content on the row it's a single empty field
          // at the end.
          if (this.row.length === 0 && this.field === '') return
          this.row.push('')
          this.emit(onRow)
        } else if (c === '\r') {
          // ignore — paired with the following \n
        } else {
          this.field += c
          this.state = 'in-field'
        }
        break

      case 'in-field':
        if (c === this.separator) {
          this.row.push(this.field)
          this.field = ''
          this.state = 'field-start'
        } else if (c === '\n') {
          this.row.push(this.field)
          this.field = ''
          this.emit(onRow)
        } else if (c === '\r') {
          // ignore CR — \n that follows triggers the row close
        } else {
          this.field += c
        }
        break

      case 'in-quoted':
        // Everything is literal in a quoted field — including separators
        // and newlines — until the next quote. The `after-quote` state
        // resolves whether that quote was an escape or the field's end.
        if (c === '"') {
          this.state = 'after-quote'
        } else {
          this.field += c
        }
        break

      case 'after-quote':
        if (c === '"') {
          // Escaped quote inside quoted field.
          this.field += '"'
          this.state = 'in-quoted'
        } else if (c === this.separator) {
          this.row.push(this.field)
          this.field = ''
          this.state = 'field-start'
        } else if (c === '\n') {
          this.row.push(this.field)
          this.field = ''
          this.emit(onRow)
        } else if (c === '\r') {
          // hold for the matching \n
        } else {
          // Malformed: junk after a closing quote with no separator/newline.
          // RFC 4180 forbids it; we keep parsing and treat as if the quote
          // hadn't closed (append the char, continue in-field) so the user
          // sees their data rather than a hard failure.
          this.errCount++
          this.field += c
          this.state = 'in-field'
        }
        break
    }
  }

  private emit(onRow: (row: string[]) => void): void {
    onRow(this.row)
    this.row = []
    this.state = 'field-start'
  }
}

export interface ParseCsvResult {
  /// All rows including the header row at index 0 (when present). Empty
  /// arrays mean an empty file or one that contained only blank lines.
  rows: string[][]
  /// Count of malformed quoting situations (unclosed quote at EOF, junk
  /// after a closing quote). The parser is lenient — none of these stop
  /// parsing — but a non-zero count usually means the file is mis-quoted.
  errors: number
}

/// Synchronous whole-text parser. Strips a leading BOM if present.
export function parseCsvText(text: string, separator: string = ','): ParseCsvResult {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const parser = new CsvParser(separator)
  const rows: string[][] = []
  const push = (row: string[]): void => {
    rows.push(row)
  }
  parser.feed(cleaned, push)
  parser.end(push)
  return { rows, errors: parser.errors }
}

/// Pull CSV records out of a ReadableStream one complete row at a time.
/// Same contract as JsonlStream:
///   * `header` is populated once the first row is parsed
///   * `rows` grows as more bytes are consumed; each row is keyed by header
///     name, with empty strings filling in for rows shorter than the header
///     and `__extra_N` keys preserving anything past the header width
///   * `ensureRowCount(n)` resolves either when `rows.length >= n` or
///     `done` flips because the stream finished
export class CsvStream {
  readonly header: string[] = []
  readonly rows: Record<string, string>[] = []
  done = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder('utf-8')
  private readonly parser: CsvParser
  private bomStripped = false
  private headerCaptured = false
  private pending: Promise<void> = Promise.resolve()

  constructor(
    body: ReadableStream<Uint8Array>,
    /// CSV → `,`, TSV → `\t`. Anything else is accepted but unusual.
    separator: string = ',',
  ) {
    this.reader = body.getReader()
    this.parser = new CsvParser(separator)
  }

  get errors(): number {
    return this.parser.errors
  }

  async ensureRowCount(target: number): Promise<void> {
    if (this.done || this.rows.length >= target) return
    this.pending = this.pending.then(() => this.driveTo(target))
    return this.pending
  }

  private async driveTo(target: number): Promise<void> {
    const onRow = (row: string[]): void => this.handleRow(row)
    while (!this.done && this.rows.length < target) {
      const { value, done } = await this.reader.read()
      if (done) {
        // Flush any bytes the decoder is still holding (chunked multi-byte
        // char), then close out the parser so a final row without trailing
        // newline still surfaces.
        const tail = this.decoder.decode()
        if (tail.length > 0) this.parser.feed(tail, onRow)
        this.parser.end(onRow)
        this.done = true
        return
      }
      let text = this.decoder.decode(value, { stream: true })
      if (!this.bomStripped) {
        this.bomStripped = true
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      this.parser.feed(text, onRow)
    }
  }

  private handleRow(row: string[]): void {
    if (!this.headerCaptured) {
      // Anonymous columns: an empty header cell turns into `column_${n}` so
      // the row dictionary keeps non-empty, deterministic keys. Duplicate
      // names get an `_${n}` suffix for the same reason — JS object lookup
      // would otherwise lose data.
      const seen = new Set<string>()
      for (let i = 0; i < row.length; i++) {
        let name = row[i]!.trim()
        if (name.length === 0) name = `column_${i + 1}`
        let unique = name
        let suffix = 2
        while (seen.has(unique)) {
          unique = `${name}_${suffix++}`
        }
        seen.add(unique)
        this.header.push(unique)
      }
      this.headerCaptured = true
      return
    }
    const obj: Record<string, string> = {}
    for (let i = 0; i < this.header.length; i++) {
      obj[this.header[i]!] = row[i] ?? ''
    }
    for (let i = this.header.length; i < row.length; i++) {
      // Data rows wider than the header — keep the value rather than drop
      // silently so the user can spot mis-aligned files.
      obj[`__extra_${i + 1}`] = row[i]!
    }
    this.rows.push(obj)
  }
}

/// Pick the field separator for a CSV-family file based on its extension.
/// `.tsv` files use tab; everything else (including `.csv`) uses comma.
export function csvSeparatorFor(fileKey: string): ',' | '\t' {
  return fileKey.toLowerCase().endsWith('.tsv') ? '\t' : ','
}
