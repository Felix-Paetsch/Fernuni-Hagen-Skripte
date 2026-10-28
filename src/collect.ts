import { unlinkSync } from "node:fs";

import { fail, reportAndExit } from "./errors.ts";
import { loadSubmissions, parseBlattPath } from "./paths.ts";
import { compressPdf, mergePdfs, pageCount, prepareSubmissions } from "./pdf.ts";

const command = "collect_unkorrigiert";

function main(): void {
  const pathArg = process.argv[2];
  if (process.argv.length !== 3 || pathArg === undefined || pathArg === "") {
    fail(`${command}: expected one path, Course/BlattN.
For example: LA_WiSe2627/Blatt1`);
  }

  const blatt = parseBlattPath(pathArg, command);
  const prepared = prepareSubmissions(loadSubmissions(blatt, command), command);
  try {
    writeNotes(prepared.notes);
    const total = prepared.files.reduce((sum, file) => sum + file.pages, 0);
    const output = blatt.mergedPdf;
    mergePdfs(
      prepared.files.map((file) => file.pdfPath),
      output,
      command,
    );

    const mergedPages = pageCount(output, command);
    if (mergedPages !== total) {
      let deleted = true;
      let deleteDetail = "";
      try {
        unlinkSync(output);
      } catch (error) {
        deleted = false;
        deleteDetail = error instanceof Error ? error.message : String(error);
      }
      const removed = deleted
        ? `The output file "${output}" was deleted.`
        : `Tried to delete "${output}", but that failed: ${deleteDetail}`;
      fail(`${command}: page count mismatch for "${output}".
  pages in merged file: ${mergedPages}
  pages in input files: ${total}
The merged file must have exactly the same number of pages as the inputs combined.
${removed}`);
    }

    compressPdf(output, command);
    process.stdout.write(`Merged ${prepared.files.length} files (${total} pages) into ${output}\n`);
  } finally {
    prepared.cleanup();
  }
}

function writeNotes(notes: readonly string[]): void {
  if (notes.length > 0) {
    process.stderr.write(`${notes.join("\n")}\n`);
  }
}

try {
  main();
} catch (error) {
  reportAndExit(error);
}
