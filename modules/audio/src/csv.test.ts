import { describe, expect, it } from "vitest";
import { parseCsv, parseSceneRowsFromCsv } from "./csv";
import { CsvFormatError } from "./types";

describe("parseCsv", () => {
  it("splits simple comma-separated rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields containing commas", () => {
    expect(parseCsv('name,note\n"Doe, John",hello')).toEqual([
      ["name", "note"],
      ["Doe, John", "hello"],
    ]);
  });

  it("handles escaped double quotes inside quoted fields", () => {
    expect(parseCsv('text\n"She said ""hi""."')).toEqual([["text"], ['She said "hi".']]);
  });

  it("handles quoted fields containing embedded newlines", () => {
    expect(parseCsv('text\n"line one\nline two"')).toEqual([["text"], ["line one\nline two"]]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("drops trailing blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("parseSceneRowsFromCsv", () => {
  it("parses a well-formed CSV using canonical headers", () => {
    const csv = ["text,title,voiceName,character,style,emotion,language,sceneNumber,targetDuration",
      '"Hello world",Intro,Narrator,Hero,calm,happy,en-US,1,4.5'].join("\n");

    const { rows, errors } = parseSceneRowsFromCsv(csv);

    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        text: "Hello world",
        title: "Intro",
        voiceName: "Narrator",
        character: "Hero",
        style: "calm",
        emotion: "happy",
        language: "en-US",
        sceneNumber: 1,
        targetDuration: 4.5,
      },
    ]);
  });

  it("recognizes header aliases case-insensitively", () => {
    const csv = ["Scene Text,Scene Number,Duration", "Only text here,7,12"].join("\n");

    const { rows, errors } = parseSceneRowsFromCsv(csv);

    expect(errors).toEqual([]);
    expect(rows).toEqual([{ text: "Only text here", sceneNumber: 7, targetDuration: 12 }]);
  });

  it("only requires the text column — all others are optional", () => {
    const csv = ["text", "Just this"].join("\n");

    const { rows, errors } = parseSceneRowsFromCsv(csv);

    expect(errors).toEqual([]);
    expect(rows).toEqual([{ text: "Just this" }]);
  });

  it("throws CsvFormatError when the CSV is empty", () => {
    expect(() => parseSceneRowsFromCsv("")).toThrow(CsvFormatError);
  });

  it("throws CsvFormatError when there is no recognizable text column", () => {
    const csv = ["title,character", "Intro,Hero"].join("\n");

    expect(() => parseSceneRowsFromCsv(csv)).toThrow(/text.*column/i);
  });

  it("collects a per-row error for a blank text cell without discarding other valid rows", () => {
    const csv = ["text", "Valid row", "   ", "Another valid row"].join("\n");

    const { rows, errors } = parseSceneRowsFromCsv(csv);

    expect(rows).toEqual([{ text: "Valid row" }, { text: "Another valid row" }]);
    expect(errors).toEqual([{ rowNumber: 2, message: '"text" is required and cannot be blank.' }]);
  });

  it("collects a per-row error for a non-numeric sceneNumber", () => {
    const csv = ["text,sceneNumber", "Hello,abc"].join("\n");

    const { rows, errors } = parseSceneRowsFromCsv(csv);

    expect(rows).toEqual([]);
    expect(errors).toEqual([{ rowNumber: 1, message: '"sceneNumber" must be a number, got "abc".' }]);
  });

  it("collects a per-row error for a non-numeric targetDuration", () => {
    const csv = ["text,targetDuration", "Hello,forever"].join("\n");

    const { rows, errors } = parseSceneRowsFromCsv(csv);

    expect(rows).toEqual([]);
    expect(errors).toEqual([{ rowNumber: 1, message: '"targetDuration" must be a number, got "forever".' }]);
  });

  it("treats blank optional cells as absent rather than empty strings", () => {
    const csv = ["text,title,voiceName", "Hello,,"].join("\n");

    const { rows, errors } = parseSceneRowsFromCsv(csv);

    expect(errors).toEqual([]);
    expect(rows).toEqual([{ text: "Hello" }]);
  });

  it("trims surrounding whitespace from text and optional fields", () => {
    const csv = ["text,title", "  Hello world  ,  Intro  "].join("\n");

    const { rows } = parseSceneRowsFromCsv(csv);

    expect(rows).toEqual([{ text: "Hello world", title: "Intro" }]);
  });
});
