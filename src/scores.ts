import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fail } from "./errors.ts";

export interface ScoreRow {
  matrikel: string;
  prefix: string;
  punkte: string;
}

export interface ExerciseSheet {
  exercise: number;
  filename: string;
  bom: boolean;
  newline: "\r\n" | "\n";
  headerLine: string;
  rows: ScoreRow[];
  byMatrikel: Map<string, ScoreRow>;
}

export interface ScoreBook {
  sheets: Map<number, ExerciseSheet>;
}

const csvPattern = /^Aufgabe_(\d+)_Bewertung\.csv$/;
const headerLine = "MatrikelNr;Vorname;Nachname;Punkte";

export function loadScoreBook(
  unkorrigiertDir: string,
  korrigiertDir: string,
  command: string,
): ScoreBook {
  let names: string[];
  try {
    names = readdirSync(unkorrigiertDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${command}: cannot read "${unkorrigiertDir}".
${detail}`);
  }

  const sheets = new Map<number, ExerciseSheet>();
  for (const filename of names.sort(compareNames)) {
    const exerciseText = csvPattern.exec(filename)?.[1];
    if (exerciseText === undefined) {
      continue;
    }
    const exercise = Number(exerciseText);
    if (!Number.isSafeInteger(exercise)) {
      fail(`${command}: "${unkorrigiertDir}/${filename}" has an exercise number that is too large.`);
    }
    const template = readCsv(`${unkorrigiertDir}/${filename}`, command);
    const sheet: ExerciseSheet = { exercise, filename, ...template };
    const savedPath = join(korrigiertDir, filename);
    if (fileExists(savedPath)) {
      applySavedPoints(sheet, readCsv(savedPath, command), savedPath, command);
    }
    sheets.set(exercise, sheet);
  }
  return { sheets };
}

export function writeSheet(dir: string, sheet: ExerciseSheet): void {
  const lines = [sheet.headerLine, ...sheet.rows.map((row) => `${row.prefix};${row.punkte}`)];
  const body = `${lines.join(sheet.newline)}${sheet.newline}`;
  const bom = sheet.bom ? "\uFEFF" : "";
  writeFileSync(join(dir, sheet.filename), `${bom}${body}`, "utf8");
}

function readCsv(file: string, command: string): Omit<ExerciseSheet, "exercise" | "filename"> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${command}: cannot read "${file}".
${detail}`);
  }

  const bom = text.startsWith("\uFEFF");
  if (bom) {
    text = text.slice(1);
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const header = lines[0];
  if (header !== headerLine) {
    fail(`${command}: "${file}" must start with the header ${headerLine}.`);
  }

  const rows: ScoreRow[] = [];
  const byMatrikel = new Map<string, ScoreRow>();
  for (const line of lines.slice(1)) {
    if (line === "") {
      continue;
    }
    const row = parseRow(file, line, command);
    if (byMatrikel.has(row.matrikel)) {
      fail(`${command}: "${row.matrikel}" appears more than once in "${file}".`);
    }
    rows.push(row);
    byMatrikel.set(row.matrikel, row);
  }
  return { bom, newline, headerLine: header, rows, byMatrikel };
}

function parseRow(file: string, line: string, command: string): ScoreRow {
  const semi = line.lastIndexOf(";");
  if (semi <= 0) {
    fail(`${command}: "${file}" has a row without a Punkte column.
  ${line}`);
  }
  const prefix = line.slice(0, semi);
  const matrikel = prefix.split(";")[0];
  if (matrikel === undefined || matrikel === "") {
    fail(`${command}: "${file}" has a row without a MatrikelNr.
  ${line}`);
  }
  return { matrikel, prefix, punkte: line.slice(semi + 1).trim() };
}

function applySavedPoints(
  sheet: ExerciseSheet,
  saved: Omit<ExerciseSheet, "exercise" | "filename">,
  file: string,
  command: string,
): void {
  const seen = new Set<string>();
  for (const row of saved.rows) {
    if (seen.has(row.matrikel)) {
      fail(`${command}: "${row.matrikel}" appears more than once in "${file}".`);
    }
    seen.add(row.matrikel);
    const target = sheet.byMatrikel.get(row.matrikel);
    if (target !== undefined) {
      target.punkte = row.punkte;
    }
  }
}

function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (nodeCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function nodeCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}
