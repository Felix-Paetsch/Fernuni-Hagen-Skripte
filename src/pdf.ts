import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, UserError } from "./errors.ts";
import type { Submission } from "./paths.ts";

export interface CountedSubmission extends Submission {
  pages: number;
  pdfPath: string;
}

export interface PreparedSubmissions {
  files: CountedSubmission[];
  notes: string[];
  cleanup: () => void;
}

type PageCountResult = { ok: true; pages: number } | { ok: false; reason: string };

export function prepareSubmissions(
  submissions: readonly Submission[],
  command: string,
): PreparedSubmissions {
  let tempDir: string | undefined;
  const cleanup = (): void => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  };

  try {
    const problems: string[] = [];
    const notes: string[] = [];
    const files: CountedSubmission[] = [];
    let imageIndex = 0;

    for (const submission of submissions) {
      const kind = sniff(submission.relativePath);
      if (kind === "jpeg" || kind === "png") {
        tempDir ??= mkdtempSync(join(tmpdir(), "la-korrektur-"));
        const pdfPath = join(tempDir, `image-${imageIndex}.pdf`);
        imageIndex += 1;
        const converted = convertImage(submission.relativePath, pdfPath, kind);
        if (!converted.ok) {
          problems.push(formatProblem(submission.relativePath, converted.reason));
          continue;
        }
        const pages = readPageCount(pdfPath, command);
        if (!pages.ok) {
          problems.push(formatProblem(submission.relativePath, pages.reason));
          continue;
        }
        notes.push(
          `  ${submission.relativePath} (${kind === "jpeg" ? "JPEG" : "PNG"} image, included as ${pages.pages} PDF page${pages.pages === 1 ? "" : "s"})`,
        );
        files.push({ ...submission, pages: pages.pages, pdfPath });
        continue;
      }

      const result = readPageCount(submission.relativePath, command);
      if (!result.ok) {
        problems.push(formatProblem(submission.relativePath, result.reason));
        continue;
      }
      files.push({ ...submission, pages: result.pages, pdfPath: submission.relativePath });
    }

    if (problems.length > 0) {
      const noun = problems.length === 1 ? "file" : "files";
      fail(`${command}: ${problems.length} ${noun} could not be read as a PDF:

${problems.join("\n")}

Every file ending with "Loesung.pdf" must be a PDF with at least one page.`);
    }

    const noteBlock =
      notes.length === 0
        ? []
        : [
            `${command}: ${notes.length} ${notes.length === 1 ? "file is an image" : "files are images"} with a Loesung.pdf name.`,
            "Each one is included as a PDF page:",
            ...notes,
          ];

    return { files, notes: noteBlock, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function pageCount(file: string, command: string): number {
  const result = readPageCount(file, command);
  if (!result.ok) {
    fail(`${command}: cannot read "${file}".
${result.reason}`);
  }
  return result.pages;
}

export function tryPageCount(file: string, command: string): number | undefined {
  try {
    const result = readPageCount(file, command);
    return result.ok ? result.pages : undefined;
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    return undefined;
  }
}

export function mergePdfs(inputs: readonly string[], output: string, command: string): void {
  runQpdf(
    ["--empty", "--pages", ...inputs, "--", output],
    `merging ${inputs.length} files into ${output}`,
    command,
  );
}

export function extractPages(
  source: string,
  start: number,
  end: number,
  output: string,
  command: string,
): void {
  runQpdf(
    [source, "--pages", source, `${start}-${end}`, "--", output],
    `extracting pages ${start}-${end} of ${source} into ${output}`,
    command,
  );
}

export function compressPdf(file: string, command: string): void {
  const temp = `${file}.compressing.pdf`;
  try {
    runGhostscript(temp, file, command);
    const before = pageCount(file, command);
    const after = tryPageCount(temp, command);
    if (after === undefined) {
      fail(`${command}: ghostscript did not produce a readable PDF for "${file}".
The uncompressed merge is still at "${file}".`);
    }
    if (after !== before) {
      fail(`${command}: ghostscript changed the page count of "${file}".
  pages before compression: ${before}
  pages after compression: ${after}
The uncompressed merge is still at "${file}".`);
    }
    renameSync(temp, file);
  } catch (error) {
    removeFile(temp);
    throw error;
  }
}

function readPageCount(file: string, command: string): PageCountResult {
  const kind = sniff(file);
  if (kind === "empty") {
    return { ok: false, reason: "This file is empty." };
  }

  const result = spawnQpdf(["--show-npages", file], command);
  if (!result.ok) {
    if (kind === "jpeg") {
      return { ok: false, reason: "This file is a JPEG image, not a PDF." };
    }
    if (kind === "png") {
      return { ok: false, reason: "This file is a PNG image, not a PDF." };
    }
    const lead =
      kind === "pdf"
        ? "qpdf could not read this PDF."
        : "This file does not look like a PDF, and qpdf could not read it.";
    return { ok: false, reason: `${lead}\n${result.detail}` };
  }

  const text = result.stdout.trim();
  if (!/^[0-9]+$/.test(text)) {
    return {
      ok: false,
      reason: `qpdf did not report a page count.\nOutput was: ${JSON.stringify(result.stdout)}`,
    };
  }
  const pages = Number(text);
  if (!Number.isSafeInteger(pages)) {
    return { ok: false, reason: `qpdf reported a page count that is too large: ${text}` };
  }
  if (pages === 0) {
    return { ok: false, reason: "This PDF has 0 pages." };
  }
  return { ok: true, pages };
}

function convertImage(
  image: string,
  output: string,
  kind: "jpeg" | "png",
): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync("magick", [`${kind}:${image}`, output], { encoding: "utf8" });
  if (result.error) {
    if (nodeCode(result.error) === "ENOENT") {
      return {
        ok: false,
        reason: `This file is a ${kind === "jpeg" ? "JPEG" : "PNG"} image, not a PDF.
ImageMagick (magick) is not installed, so it cannot be included.`,
      };
    }
    return { ok: false, reason: result.error.message };
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim() || "(no error output)";
    return {
      ok: false,
      reason: `This file is a ${kind === "jpeg" ? "JPEG" : "PNG"} image, not a PDF.
ImageMagick could not turn it into a PDF.
${detail}`,
    };
  }
  return { ok: true };
}

type SpawnResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; detail: string };

function runGhostscript(output: string, input: string, command: string): void {
  const args = [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dPDFSETTINGS=/ebook",
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    `-sOutputFile=${output}`,
    input,
  ];
  const result = spawnSync("gs", args, { encoding: "utf8" });
  if (result.error) {
    if (nodeCode(result.error) === "ENOENT") {
      fail(`${command}: ghostscript (gs) is required to compress "${input}", but it was not found on PATH.
The uncompressed merge is still at "${input}".
Install ghostscript, then run the command again.`);
    }
    fail(`${command}: ghostscript failed while compressing "${input}".
${result.error.message}
The uncompressed merge is still at "${input}".`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim() || "(no error output)";
    const statusText =
      result.status === null ? `signal ${result.signal}` : `exit code ${result.status}`;
    fail(`${command}: ghostscript failed while compressing "${input}".
${detail}
(${statusText})
The uncompressed merge is still at "${input}".`);
  }
}

function runQpdf(
  args: readonly string[],
  action: string,
  command: string,
): { stdout: string; stderr: string } {
  const result = spawnQpdf(args, command);
  if (!result.ok) {
    fail(`${command}: qpdf failed while ${action}.
Command: ${formatCommand(args)}
${result.detail}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function spawnQpdf(args: readonly string[], command: string): SpawnResult {
  const result = spawnSync("qpdf", args, { encoding: "utf8" });
  if (result.error) {
    if (nodeCode(result.error) === "ENOENT") {
      fail(`${command}: qpdf is required but was not found on PATH.
Install qpdf, then run the command again.`);
    }
    return { ok: false, detail: result.error.message };
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status === 0 || result.status === 3) {
    return { ok: true, stdout, stderr };
  }

  const detail = stderr.trim() || stdout.trim() || "(no error output)";
  const statusText = result.status === null ? `signal ${result.signal}` : `exit code ${result.status}`;
  return { ok: false, detail: `${detail}\n(${statusText})` };
}

function sniff(file: string): "pdf" | "jpeg" | "png" | "empty" | "other" {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(8);
    const read = readSync(fd, header, 0, header.length, 0);
    if (read === 0) {
      return "empty";
    }
    if (header.subarray(0, 5).toString("latin1") === "%PDF-") {
      return "pdf";
    }
    if (read >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return "jpeg";
    }
    if (
      read >= 4 &&
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47
    ) {
      return "png";
    }
    return "other";
  } finally {
    closeSync(fd);
  }
}

function formatProblem(file: string, reason: string): string {
  const body = reason
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `  ${file}\n${body}`;
}

function formatCommand(args: readonly string[]): string {
  return ["qpdf", ...args].map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_./:@+=,-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // A failed temp cleanup should not hide the original error.
  }
}

function nodeCode(error: Error): string | undefined {
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}
