import { readdirSync, statSync } from "node:fs";

import { fail } from "./errors.ts";

export interface BlattPath {
  course: string;
  blatt: string;
  relative: string;
  unkorrigiert: string;
  korrigiertPdf: string;
  korrigiertDir: string;
  mergedPdf: string;
}

export interface Submission {
  filename: string;
  relativePath: string;
  sortNumber: number;
}

const twoPartPattern = /^([^/]+)\/([^/]+)$/;
const blattNamePattern = /^Blatt[0-9]+$/;
const submissionNamePattern = /^(\d{7})_(\d*)_(\d*)_(.*)$/;
const loesungSuffix = /loesung\.pdf$/i;

export function parseBlattPath(pathArg: string, command: string): BlattPath {
  const trimmed = pathArg.replace(/\/+$/, "");
  const match = twoPartPattern.exec(trimmed);
  const course = match?.[1];
  const blatt = match?.[2];
  if (
    course === undefined ||
    blatt === undefined ||
    course === "." ||
    course === ".." ||
    blatt === "." ||
    blatt === ".."
  ) {
    fail(`${command}: invalid path "${pathArg}".
Expected Course/BlattN, for example LA_WiSe2627/Blatt1.
Course is a folder in this directory. BlattN is a folder inside it named Blatt followed by digits.`);
  }
  if (!blattNamePattern.test(blatt)) {
    fail(`${command}: invalid path "${pathArg}".
The second folder must be named Blatt followed by digits (for example Blatt1).`);
  }

  assertCourseDirectory(course, command);
  assertBlattDirectory(course, blatt, command);

  const relative = `${course}/${blatt}`;
  return {
    course,
    blatt,
    relative,
    unkorrigiert: `${relative}/unkorrigiert`,
    korrigiertPdf: `${relative}/korrigiert.pdf`,
    korrigiertDir: `${relative}/korrigiert`,
    mergedPdf: `${relative}/unkorrigiert_merged.pdf`,
  };
}

export function korrigiertFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) {
    return `${filename}_korrigiert`;
  }
  return `${filename.slice(0, dot)}_korrigiert${filename.slice(dot)}`;
}

export function loadSubmissions(blatt: BlattPath, command: string): Submission[] {
  let names: string[];
  try {
    names = readdirSync(blatt.unkorrigiert, { withFileTypes: true })
      .filter((entry) => entry.isFile() && loesungSuffix.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") {
      fail(`${command}: "${blatt.unkorrigiert}" not found.
Expected a folder of Loesung.pdf files there.`);
    }
    if (nodeCode(error) === "ENOTDIR") {
      fail(`${command}: "${blatt.unkorrigiert}" is not a folder.
Expected a folder of Loesung.pdf files there.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${command}: cannot read "${blatt.unkorrigiert}".
${detail}`);
  }

  if (names.length === 0) {
    fail(`${command}: no PDF files ending with "Loesung.pdf" in "${blatt.unkorrigiert}".
Expected names like 2133911_1_4_Loesung.pdf.
CSV files and other PDFs in that folder are ignored.`);
  }

  const bad: { name: string; reason: string }[] = [];
  const submissions: Submission[] = [];
  for (const filename of names) {
    const parsed = parseSubmissionName(filename);
    if ("error" in parsed) {
      bad.push({ name: filename, reason: parsed.error });
      continue;
    }
    submissions.push({
      filename,
      relativePath: `${blatt.unkorrigiert}/${filename}`,
      sortNumber: parsed.sortNumber,
    });
  }

  if (bad.length > 0) {
    bad.sort((left, right) => compareNames(left.name, right.name));
    const listed = bad.map((entry) => `  ${entry.name}\n    ${entry.reason}`).join("\n");
    const noun = bad.length === 1 ? "file" : "files";
    const verb = bad.length === 1 ? "ends" : "end";
    fail(`${command}: ${bad.length} ${noun} in "${blatt.unkorrigiert}" ${verb} with "Loesung.pdf"
but cannot be used:

${listed}

Expected names like 2133911_1_4_Loesung.pdf
(7 digits, underscore, digits, underscore, digits, underscore, then anything).
The digits between the last two underscores are the number used for sorting.`);
  }

  submissions.sort((left, right) => {
    if (left.sortNumber !== right.sortNumber) {
      return left.sortNumber - right.sortNumber;
    }
    return compareNames(left.filename, right.filename);
  });
  return submissions;
}

function assertCourseDirectory(course: string, command: string): void {
  let info;
  try {
    info = statSync(course);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") {
      fail(`${command}: "${course}" is not a folder in this directory.
Looked in ${process.cwd()}.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${command}: cannot read "${course}".
${detail}`);
  }
  if (!info.isDirectory()) {
    fail(`${command}: "${course}" is not a folder in this directory.
Looked in ${process.cwd()}.`);
  }
}

function assertBlattDirectory(course: string, blatt: string, command: string): void {
  const relative = `${course}/${blatt}`;
  let info;
  try {
    info = statSync(relative);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") {
      fail(`${command}: "${relative}" is not a folder.
"${course}" exists, but "${blatt}" does not.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${command}: cannot read "${relative}".
${detail}`);
  }
  if (!info.isDirectory()) {
    fail(`${command}: "${relative}" is not a folder.`);
  }
}

function parseSubmissionName(filename: string): { sortNumber: number } | { error: string } {
  const match = submissionNamePattern.exec(filename);
  const sortText = match?.[3];
  if (match === null || sortText === undefined) {
    return { error: "does not match DDDDDDD_D*_D*_.*" };
  }
  if (sortText.length === 0) {
    return {
      error: "the number between the last underscores is missing, so the file cannot be sorted",
    };
  }
  const sortNumber = Number(sortText);
  if (!Number.isSafeInteger(sortNumber)) {
    return {
      error: `the number between the last underscores (${sortText}) is too large to sort`,
    };
  }
  return { sortNumber };
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
