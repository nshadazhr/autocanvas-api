import { CsvFormatError, type CsvRowError, type ParsedSceneRow } from "./types";

/**
 * Minimal RFC 4180-ish CSV tokenizer — hand-rolled instead of pulling in a
 * dependency because the format this module needs to handle is small and
 * well-defined (quoted fields, escaped `""` quotes, commas/newlines inside
 * quoted fields, `\r\n` or `\n` line endings), and a hand-rolled tokenizer
 * that's fully covered by unit tests is easier to trust here than an
 * external dependency neither this repo nor its tests have exercised yet.
 *
 * Returns rows of raw string cells — no header handling, no trimming, no
 * type coercion. That all happens in parseSceneRowsFromCsv() below.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (char === "\r") {
      // Swallow bare \r and \r\n alike — the following \n (if any) drives
      // the actual row break below.
      i += 1;
      continue;
    }
    if (char === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // Trailing field/row not terminated by a newline (last line of the file).
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // Drop trailing blank lines only (e.g. one or more empty lines right
  // before EOF) — NOT blank rows anywhere in the middle of the file. A
  // single-column CSV can legitimately have a data row whose only cell is
  // blank/whitespace (e.g. a scene with empty "text"); that's a validation
  // problem for parseSceneRowsFromCsv to report as a per-row error, not
  // something this tokenizer should silently erase.
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell.trim().length === 0)) {
    rows.pop();
  }

  return rows;
}

const HEADER_ALIASES: Record<string, keyof ParsedSceneRow> = {
  text: "text",
  "scene text": "text",
  content: "text",
  scenenumber: "sceneNumber",
  "scene number": "sceneNumber",
  "scene no": "sceneNumber",
  "scene #": "sceneNumber",
  title: "title",
  voicename: "voiceName",
  voice: "voiceName",
  "voice name": "voiceName",
  character: "character",
  style: "style",
  emotion: "emotion",
  language: "language",
  lang: "language",
  targetduration: "targetDuration",
  "target duration": "targetDuration",
  duration: "targetDuration",
};

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface ParseSceneCsvResult {
  rows: ParsedSceneRow[];
  errors: CsvRowError[];
}

/**
 * Parses an uploaded CSV's text into scene rows ready for import, WITHOUT
 * touching the database — voice-name-to-VoiceProfile resolution and
 * AudioScene row creation happen in a separate step (apps/web's
 * `importScenesFromCsv` Server Action), so this function stays a pure,
 * fully unit-testable string-in/data-out transform.
 *
 * Throws CsvFormatError for structural problems that make the whole file
 * unusable (no rows at all, or no recognizable "text" column in the
 * header). Per-row problems (missing text, unparseable numbers) are
 * collected into `errors` instead of throwing, so one bad row doesn't
 * block importing the rest of a large CSV.
 */
export function parseSceneRowsFromCsv(csvText: string): ParseSceneCsvResult {
  const table = parseCsv(csvText);
  if (table.length === 0) {
    throw new CsvFormatError("CSV is empty.");
  }

  const [headerRow, ...dataRows] = table;
  const columnMap: Array<keyof ParsedSceneRow | null> = headerRow.map((cell) => HEADER_ALIASES[normalizeHeader(cell)] ?? null);

  if (!columnMap.includes("text")) {
    throw new CsvFormatError('CSV must include a "text" column (aliases: "scene text", "content").');
  }

  const rows: ParsedSceneRow[] = [];
  const errors: CsvRowError[] = [];

  dataRows.forEach((cells, index) => {
    const rowNumber = index + 1;
    const raw: Partial<Record<keyof ParsedSceneRow, string>> = {};
    columnMap.forEach((field, columnIndex) => {
      if (!field) return;
      const value = cells[columnIndex];
      if (value !== undefined) {
        raw[field] = value;
      }
    });

    const text = raw.text?.trim() ?? "";
    if (text.length === 0) {
      errors.push({ rowNumber, message: '"text" is required and cannot be blank.' });
      return;
    }

    const parsed: ParsedSceneRow = { text };

    if (raw.title !== undefined && raw.title.trim().length > 0) parsed.title = raw.title.trim();
    if (raw.voiceName !== undefined && raw.voiceName.trim().length > 0) parsed.voiceName = raw.voiceName.trim();
    if (raw.character !== undefined && raw.character.trim().length > 0) parsed.character = raw.character.trim();
    if (raw.style !== undefined && raw.style.trim().length > 0) parsed.style = raw.style.trim();
    if (raw.emotion !== undefined && raw.emotion.trim().length > 0) parsed.emotion = raw.emotion.trim();
    if (raw.language !== undefined && raw.language.trim().length > 0) parsed.language = raw.language.trim();

    if (raw.sceneNumber !== undefined && raw.sceneNumber.trim().length > 0) {
      const sceneNumber = Number(raw.sceneNumber.trim());
      if (!Number.isFinite(sceneNumber)) {
        errors.push({ rowNumber, message: `"sceneNumber" must be a number, got "${raw.sceneNumber}".` });
        return;
      }
      parsed.sceneNumber = sceneNumber;
    }

    if (raw.targetDuration !== undefined && raw.targetDuration.trim().length > 0) {
      const targetDuration = Number(raw.targetDuration.trim());
      if (!Number.isFinite(targetDuration)) {
        errors.push({ rowNumber, message: `"targetDuration" must be a number, got "${raw.targetDuration}".` });
        return;
      }
      parsed.targetDuration = targetDuration;
    }

    rows.push(parsed);
  });

  return { rows, errors };
}
