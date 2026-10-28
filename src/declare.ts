import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fail, reportAndExit, UserError } from "./errors.ts";
import {
  korrigiertFilename,
  loadSubmissions,
  parseBlattPath,
  type BlattPath,
  type Submission,
} from "./paths.ts";
import { pageCount } from "./pdf.ts";
import { loadScoreBook, writeSheet, type ExerciseSheet, type ScoreBook, type ScoreRow } from "./scores.ts";
import { splitKorrigiert } from "./split.ts";

const command = "declare_points";
const port = 3009;
const scorePattern = /^\d+(?:[.,]\d+)?$/;

interface LinkedSubmission {
  matrikel: string;
  exercise: number;
  relativePath: string;
  pdfPath: string;
  pages: number;
  row: ScoreRow;
  sheet: ExerciseSheet;
}

interface ClientState {
  startIndex: number;
  corrected: number;
  cacheToken: string;
  submissions: { pages: number; points: string }[];
}

function main(): void {
  const pathArg = process.argv[2];
  if (process.argv.length !== 3 || pathArg === undefined || pathArg === "") {
    fail(`${command}: expected one path, Course/BlattN.
For example: LA_WiSe2627/Blatt1`);
  }

  const blatt = parseBlattPath(pathArg, command);
  const book = loadScoreBook(blatt.unkorrigiert, blatt.korrigiertDir, command);
  const linked = linkSubmissions(blatt, loadSubmissions(blatt, command), book, command);
  if (!korrigiertPdfsReady(linked)) {
    splitKorrigiert(blatt, command);
  }
  for (const item of linked) {
    item.pages = pageCount(item.pdfPath, command);
  }
  assertPdftoppm();

  const cacheToken = randomBytes(8).toString("hex");
  const cacheDir = mkdtempSync(join(tmpdir(), "korrektur-pages-"));
  const removeCache = (): void => {
    rmSync(cacheDir, { recursive: true, force: true });
  };
  process.on("SIGINT", () => {
    removeCache();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    removeCache();
    process.exit(0);
  });

  const server = createServer((req, res) => {
    void handle(req, res, linked, blatt.korrigiertDir, cacheDir, cacheToken).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end(`${message}\n`);
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    removeCache();
    if (error.code === "EADDRINUSE") {
      reportAndExit(new UserError(`${command}: port ${port} is already in use.`));
    }
    reportAndExit(error);
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`http://127.0.0.1:${port}/\n`);
  });
}

function linkSubmissions(
  blatt: BlattPath,
  submissions: readonly Submission[],
  book: ScoreBook,
  commandName: string,
): LinkedSubmission[] {
  const linked: LinkedSubmission[] = [];
  const seen = new Set<string>();
  for (const submission of submissions) {
    const matrikel = /^(\d{7})_/.exec(submission.filename)?.[1];
    if (matrikel === undefined) {
      fail(`${commandName}: "${submission.relativePath}" has no MatrikelNr.`);
    }
    const exercise = submission.sortNumber;
    const key = `${exercise}:${matrikel}`;
    if (seen.has(key)) {
      fail(`${commandName}: "${matrikel}" appears more than once for Aufgabe ${exercise}.`);
    }
    seen.add(key);
    const sheet = book.sheets.get(exercise);
    if (sheet === undefined) {
      fail(`${commandName}: no "Aufgabe_${exercise}_Bewertung.csv" in "${blatt.unkorrigiert}".
Expected one Bewertung CSV per exercise number in the Loesung.pdf names.
Missing for "${submission.relativePath}".`);
    }
    const row = sheet.byMatrikel.get(matrikel);
    if (row === undefined) {
      fail(`${commandName}: "${matrikel}" from "${submission.relativePath}" is not in "${sheet.filename}".`);
    }
    linked.push({
      matrikel,
      exercise,
      relativePath: submission.relativePath,
      pdfPath: `${blatt.korrigiertDir}/${korrigiertFilename(submission.filename)}`,
      pages: 0,
      row,
      sheet,
    });
  }
  return linked;
}

function korrigiertPdfsReady(linked: readonly LinkedSubmission[]): boolean {
  return linked.every((item) => isFile(item.pdfPath));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  linked: readonly LinkedSubmission[],
  korrigiertDir: string,
  cacheDir: string,
  cacheToken: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/") {
    const state = clientState(linked, cacheToken);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pageHtml(state));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/score") {
    await postScore(req, res, linked, korrigiertDir);
    return;
  }
  const pageMatch = /^\/page\/(\d+)\/(\d+)\.jpg$/.exec(url.pathname);
  if (req.method === "GET" && pageMatch !== null) {
    await servePage(pageMatch, url.searchParams.get("preload") === "1", res, linked, cacheDir);
    return;
  }
  res.statusCode = 404;
  res.end("Not found\n");
}

async function postScore(
  req: IncomingMessage,
  res: ServerResponse,
  linked: readonly LinkedSubmission[],
  korrigiertDir: string,
): Promise<void> {
  const text = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    res.statusCode = 400;
    res.end("Expected JSON.\n");
    return;
  }
  if (body === null || typeof body !== "object") {
    res.statusCode = 400;
    res.end("Expected JSON.\n");
    return;
  }
  const index = "index" in body ? body.index : undefined;
  const points = "points" in body ? body.points : undefined;
  const item = typeof index === "number" ? linked[index] : undefined;
  if (typeof index !== "number" || !Number.isInteger(index) || item === undefined) {
    res.statusCode = 400;
    res.end("Unknown submission.\n");
    return;
  }
  if (typeof points !== "string" || !scorePattern.test(points)) {
    res.statusCode = 400;
    res.end("Expected a number.\n");
    return;
  }
  item.row.punkte = points;
  writeSheet(korrigiertDir, item.sheet);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ points, corrected: correctedCount(linked) }));
}

async function servePage(
  pageMatch: RegExpExecArray,
  preload: boolean,
  res: ServerResponse,
  linked: readonly LinkedSubmission[],
  cacheDir: string,
): Promise<void> {
  const index = Number(pageMatch[1]);
  const page = Number(pageMatch[2]);
  const item = linked[index];
  if (item === undefined || !Number.isInteger(page) || page < 1 || page > item.pages) {
    res.statusCode = 404;
    res.end("Not found\n");
    return;
  }
  const file = await ensureJpeg(cacheDir, index, page, item.pdfPath, preload);
  const data = readFileSync(file);
  res.setHeader("content-type", "image/jpeg");
  res.setHeader("content-length", String(data.length));
  res.setHeader("cache-control", "private, no-cache");
  res.end(data);
}

function clientState(linked: readonly LinkedSubmission[], cacheToken: string): ClientState {
  return {
    startIndex: startIndex(linked),
    corrected: correctedCount(linked),
    cacheToken,
    submissions: linked.map((item) => ({ pages: item.pages, points: item.row.punkte })),
  };
}

function startIndex(linked: readonly LinkedSubmission[]): number {
  const index = linked.findIndex((item) => item.row.punkte === "");
  if (index === -1) {
    return linked.length - 1;
  }
  return index;
}

function correctedCount(linked: readonly LinkedSubmission[]): number {
  return linked.filter((item) => item.row.punkte !== "").length;
}

interface RenderJob {
  preload: boolean;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const renderQueue: RenderJob[] = [];
let rendering = false;

function withRenderLock(preload: boolean, job: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const item: RenderJob = { preload, run: job, resolve, reject };
    if (preload) {
      renderQueue.push(item);
    } else {
      const preloadAt = renderQueue.findIndex((entry) => entry.preload);
      if (preloadAt === -1) {
        renderQueue.push(item);
      } else {
        renderQueue.splice(preloadAt, 0, item);
      }
    }
    void pumpRender();
  });
}

async function pumpRender(): Promise<void> {
  if (rendering) {
    return;
  }
  const next = renderQueue.shift();
  if (next === undefined) {
    return;
  }
  rendering = true;
  try {
    await next.run();
    next.resolve();
  } catch (error) {
    next.reject(error);
  } finally {
    rendering = false;
    void pumpRender();
  }
}

async function ensureJpeg(
  cacheDir: string,
  index: number,
  page: number,
  pdf: string,
  preload: boolean,
): Promise<string> {
  const dest = join(cacheDir, `${index}-${page}.jpg`);
  if (existsSync(dest)) {
    return dest;
  }
  await withRenderLock(preload, async () => {
    if (existsSync(dest)) {
      return;
    }
    await runPdftoppm(pdf, page, join(cacheDir, `${index}-${page}`));
    if (!existsSync(dest)) {
      throw new Error(`pdftoppm did not write a JPEG for page ${page}.`);
    }
  });
  return dest;
}

function runPdftoppm(pdf: string, page: number, destBase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pdftoppm",
      ["-jpeg", "-r", "150", "-f", String(page), "-l", String(page), "-singlefile", pdf, destBase],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      errors.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(errors).toString("utf8").trim();
      const statusText = status === null ? "a signal" : `exit code ${status}`;
      reject(new Error(detail === "" ? `pdftoppm failed with ${statusText}.` : detail));
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function assertPdftoppm(): void {
  const result = spawnSync("pdftoppm", ["-v"], { encoding: "utf8" });
  if (result.error !== undefined && nodeCode(result.error) === "ENOENT") {
    fail(`${command}: pdftoppm is required but was not found on PATH.
Install poppler, then run the command again.`);
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (nodeCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function nodeCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function pageHtml(state: ClientState): string {
  const current = state.submissions[state.startIndex];
  const points = current?.points ?? "";
  const total = state.submissions.length;
  const position = state.startIndex + 1;
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Punkte</title>
<style>
  html, body { margin: 0; background: #000; }
  .score-box, .progress-box {
    position: fixed;
    z-index: 2;
    background: #111;
    color: #fff;
    padding: 0.4em 0.6em;
    font: 16px sans-serif;
  }
  .score-box {
    top: 0.5em;
    left: 0.5em;
    display: flex;
    gap: 0.6em;
    align-items: center;
  }
  .progress-box {
    top: 0.5em;
    right: 0.5em;
    white-space: pre-line;
  }
  input, input:focus, input:focus-visible {
    font: inherit;
    color: #fff;
    background: #000;
    border: 1px solid #666;
    width: 5em;
    outline: none;
    box-shadow: none;
  }
  img.page {
    display: block;
    width: 100%;
    height: 100vh;
    object-fit: contain;
    background: #fff;
  }
  img.page:not(:last-child) { margin-bottom: 0.5em; }
</style>
</head>
<body>
  <div class="score-box">
    <input id="points" autofocus autocomplete="off" spellcheck="false" inputmode="decimal">
    <div id="current">${points === "" ? "P: N/A" : `P: ${escapeText(points)}`}</div>
  </div>
  <div class="progress-box" id="progress">Submission: ${position}/${total}
Total Corrected: ${state.corrected}/${total}</div>
  <div id="pages">${imageTags(state.startIndex, current?.pages ?? 0, state.cacheToken)}</div>
  <script id="state" type="application/json">${JSON.stringify(state).replaceAll("<", "\\u003c")}</script>
  <script>
    const state = JSON.parse(document.getElementById("state").textContent);
    const input = document.getElementById("points");
    const current = document.getElementById("current");
    const progress = document.getElementById("progress");
    const pagesEl = document.getElementById("pages");
    let index = state.startIndex;
    let corrected = state.corrected;
    let saving = false;

    function scoreText(points) {
      return points === "" ? "P: N/A" : "P: " + points;
    }

    function pageUrl(submissionIndex, page, preload) {
      const url = "/page/" + submissionIndex + "/" + page + ".jpg?v=" + state.cacheToken;
      return preload ? url + "&preload=1" : url;
    }

    let preloadImages = [];
    let preloadGeneration = 0;

    function neighborIndexes() {
      const indexes = [];
      for (let step = 1; step <= 3; step += 1) {
        const next = index + step;
        if (next < state.submissions.length) indexes.push(next);
      }
      for (let step = 1; step <= 2; step += 1) {
        const previous = index - step;
        if (previous >= 0) indexes.push(previous);
      }
      return indexes;
    }

    function preloadUrls() {
      const neighbors = neighborIndexes();
      const urls = [];
      for (const submissionIndex of neighbors) {
        const pages = state.submissions[submissionIndex].pages;
        if (pages > 0) urls.push(pageUrl(submissionIndex, pages, true));
      }
      for (const submissionIndex of neighbors) {
        const pages = state.submissions[submissionIndex].pages;
        for (let page = pages - 1; page >= 1; page -= 1) {
          urls.push(pageUrl(submissionIndex, page, true));
        }
      }
      return urls;
    }

    function startPreload() {
      preloadGeneration += 1;
      const generation = preloadGeneration;
      preloadImages = [];
      const images = pageImages();
      const last = images[images.length - 1];
      const run = () => {
        if (generation !== preloadGeneration) return;
        preloadImages = preloadUrls().map((url) => {
          const image = new Image();
          image.src = url;
          return image;
        });
      };
      if (!last || last.complete) {
        run();
        return;
      }
      last.addEventListener("load", run, { once: true });
      last.addEventListener("error", run, { once: true });
    }

    function pageImages() {
      return pagesEl.querySelectorAll("img.page");
    }

    function scrollToImage(image) {
      window.scrollTo(0, image.offsetTop);
    }

    function scrollToLast() {
      const images = pageImages();
      const last = images[images.length - 1];
      if (last) scrollToImage(last);
    }

    function currentImageIndex() {
      const images = pageImages();
      let best = 0;
      let bestDistance = Infinity;
      const screenCenter = window.scrollY + window.innerHeight / 2;
      for (let i = 0; i < images.length; i += 1) {
        const image = images[i];
        const center = image.offsetTop + image.offsetHeight / 2;
        const distance = Math.abs(center - screenCenter);
        if (distance < bestDistance) {
          best = i;
          bestDistance = distance;
        }
      }
      return best;
    }

    function scrollPage(delta) {
      const images = pageImages();
      if (images.length === 0) {
        focusInput();
        return;
      }
      const next = currentImageIndex() + delta;
      if (next < 0 || next >= images.length) {
        focusInput();
        return;
      }
      scrollToImage(images[next]);
      focusInput();
    }

    function render() {
      const item = state.submissions[index];
      current.textContent = scoreText(item.points);
      progress.textContent = "Submission: " + (index + 1) + "/" + state.submissions.length + "\\nTotal Corrected: " + corrected + "/" + state.submissions.length;
      const tags = [];
      for (let page = 1; page <= item.pages; page += 1) {
        const priority = page === item.pages ? "high" : "low";
        tags.push('<img class="page" alt="" fetchpriority="' + priority + '" src="' + pageUrl(index, page, false) + '">');
      }
      pagesEl.innerHTML = tags.join("");
      scrollToLast();
      startPreload();
    }

    function focusInput() {
      input.focus({ preventScroll: true });
    }

    function range() {
      if (document.activeElement !== input) {
        focusInput();
        const end = input.value.length;
        return { start: end, end: end };
      }
      return {
        start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length,
      };
    }

    function insert(text) {
      const span = range();
      input.value = input.value.slice(0, span.start) + text + input.value.slice(span.end);
      const pos = span.start + text.length;
      input.selectionStart = pos;
      input.selectionEnd = pos;
      focusInput();
    }

    function backspace() {
      const span = range();
      if (span.start !== span.end) {
        input.value = input.value.slice(0, span.start) + input.value.slice(span.end);
        input.selectionStart = span.start;
        input.selectionEnd = span.start;
      } else if (span.start > 0) {
        input.value = input.value.slice(0, span.start - 1) + input.value.slice(span.start);
        input.selectionStart = span.start - 1;
        input.selectionEnd = span.start - 1;
      }
      focusInput();
    }

    function selectAll() {
      focusInput();
      input.select();
    }

    function go(delta) {
      if (saving) return;
      const next = index + delta;
      if (next < 0 || next >= state.submissions.length) {
        focusInput();
        return;
      }
      index = next;
      input.value = "";
      render();
      focusInput();
    }

    async function submitScore() {
      const points = input.value.trim();
      if (points === "" || saving) return;
      if (!/^\\d+(?:[.,]\\d+)?$/.test(points)) return;
      saving = true;
      try {
        const response = await fetch("/api/score", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ index: index, points: points }),
        });
        if (!response.ok) return;
        const body = await response.json();
        state.submissions[index].points = body.points;
        corrected = body.corrected;
        input.value = "";
        if (index < state.submissions.length - 1) index += 1;
        render();
      } finally {
        saving = false;
        focusInput();
      }
    }

    window.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        scrollPage(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        scrollPage(1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void submitScore();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAll();
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        backspace();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key) || event.key === "," || event.key === ".") {
        event.preventDefault();
        insert(event.key);
      }
    }, true);

    scrollToLast();
    startPreload();
    focusInput();
  </script>
</body>
</html>
`;
}

function imageTags(index: number, pages: number, cacheToken: string): string {
  const tags: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const priority = page === pages ? "high" : "low";
    tags.push(
      `<img class="page" alt="" fetchpriority="${priority}" src="/page/${index}/${page}.jpg?v=${cacheToken}">`,
    );
  }
  return tags.join("");
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    main();
  } catch (error) {
    reportAndExit(error);
  }
}
