import { mkdirSync, readdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { fail, reportAndExit } from "./errors.ts";
import { korrigiertFilename, loadSubmissions, parseBlattPath, type BlattPath } from "./paths.ts";
import { extractPages, pageCount, prepareSubmissions, tryPageCount } from "./pdf.ts";

const commandName = "split_korrigiert";

export function splitKorrigiert(blatt: BlattPath, command: string): void {
  const prepared = prepareSubmissions(loadSubmissions(blatt, command), command);
  try {
    writeNotes(prepared.notes);
    const total = prepared.files.reduce((sum, file) => sum + file.pages, 0);
    assertKorrigiertPdf(blatt, total, command);

    const mergedPages = pageCount(blatt.korrigiertPdf, command);
    if (mergedPages !== total && mergedPages !== total + 1) {
      fail(`${command}: page count mismatch for "${blatt.korrigiertPdf}".
  pages in korrigiert.pdf: ${mergedPages}
  pages in unkorrigiert inputs: ${total}
korrigiert.pdf must have exactly the same number of pages,
or exactly one extra page at the end (which is ignored).`);
    }

    mkdirSync(blatt.korrigiertDir, { recursive: true });

    let start = 1;
    for (const file of prepared.files) {
      const end = start + file.pages - 1;
      const outPath = `${blatt.korrigiertDir}/${korrigiertFilename(file.filename)}`;
      extractPages(blatt.korrigiertPdf, start, end, outPath, command);
      const got = pageCount(outPath, command);
      if (got !== file.pages) {
        fail(`${command}: page count mismatch after splitting ${file.filename}.
  pages in "${outPath}": ${got}
  pages in "${file.relativePath}": ${file.pages}
Each split file must have the same number of pages as the unkorrigiert file it came from.`);
      }
      start = end + 1;
    }

    const extra = mergedPages === total + 1 ? ", ignored 1 trailing page" : "";
    process.stdout.write(
      `Split ${blatt.korrigiertPdf} into ${prepared.files.length} files in ${blatt.korrigiertDir} (${total} pages${extra}).\n`,
    );
  } finally {
    prepared.cleanup();
  }
}

function main(): void {
  const pathArg = process.argv[2];
  if (process.argv.length !== 3 || pathArg === undefined || pathArg === "") {
    fail(`${commandName}: expected one path, Course/BlattN.
For example: LA_WiSe2627/Blatt1`);
  }

  const blatt = parseBlattPath(pathArg, commandName);
  splitKorrigiert(blatt, commandName);
}

function assertKorrigiertPdf(blatt: BlattPath, expectedPages: number, command: string): void {
  let info;
  try {
    info = statSync(blatt.korrigiertPdf);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") {
      fail(missingKorrigiertMessage(blatt, expectedPages, command));
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${command}: cannot read "${blatt.korrigiertPdf}".
${detail}`);
  }
  if (!info.isFile()) {
    fail(`${command}: "${blatt.korrigiertPdf}" is not a file.
Expected the corrected PDF for this Blatt.`);
  }
}

function missingKorrigiertMessage(blatt: BlattPath, expectedPages: number, command: string): string {
  const expected = blatt.korrigiertPdf;
  const candidates = renameCandidates(blatt.relative, expectedPages, command);
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    return `${command}: "${expected}" not found. Consider renaming "${only}".`;
  }
  if (candidates.length > 1) {
    const listed = candidates.map((pdf) => `  "${pdf}"`).join("\n");
    return `${command}: "${expected}" not found. Consider renaming one of:
${listed}`;
  }
  return `${command}: "${expected}" not found.`;
}

function renameCandidates(blattDir: string, expectedPages: number, command: string): string[] {
  let entries;
  try {
    entries = readdirSync(blattDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort(compareNames);

  const matches: string[] = [];
  for (const name of names) {
    const relative = `${blattDir}/${name}`;
    const pages = tryPageCount(relative, command);
    if (pages === expectedPages || pages === expectedPages + 1) {
      matches.push(relative);
    }
  }
  return matches;
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

function writeNotes(notes: readonly string[]): void {
  if (notes.length > 0) {
    process.stderr.write(`${notes.join("\n")}\n`);
  }
}

function nodeCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    reportAndExit(error);
  }
}
