// Builds the GitHub Pages site into _site/ with cache busting. Pages serves everything with a
// 10-minute cache and no way to change headers, so a deploy could otherwise mix old and new files:
//  - every relative module import gets ?v=<version>, so a new deploy loads a whole new module graph
//  - version.js is stamped, so model/animation asset URLs carry the version too
//  - each page's entry script is loaded via a never-cached version.json, so even a cached HTML
//    page picks up the newest build immediately
//   node tools/build-pages.mjs [version]     (defaults to $GITHUB_SHA or the git HEAD)
import { cp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "public"), OUT = join(ROOT, "_site");
const VERSION = (process.argv[2] ?? process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: ROOT }).toString()).trim().slice(0, 12);

const IMPORT = /((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"'?]+\.js)\2/g;
const ENTRY = /<script type="module" src="(\.\/[^"]+\.js)"><\/script>/g;

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else yield p;
  }
}

await rm(OUT, { recursive: true, force: true });
await cp(SRC, OUT, { recursive: true });
let jsCount = 0, htmlCount = 0;
for await (const file of files(OUT)) {
  const ext = extname(file);
  if (ext === ".js") {
    let src = await readFile(file, "utf8");
    src = src.replace(IMPORT, (_, pre, q, spec) => `${pre}${q}${spec}?v=${VERSION}${q}`);
    if (file.endsWith("/game/version.js")) src = src.replace('export const VERSION = "dev";', `export const VERSION = "${VERSION}";`);
    await writeFile(file, src);
    jsCount++;
  } else if (ext === ".html") {
    let html = await readFile(file, "utf8");
    html = html.replace(ENTRY, (_, entry) => `<script type="module">
  // Load the newest build even if this page itself came from cache (see tools/build-pages.mjs).
  fetch("./version.json", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ v: "${VERSION}" }))
    .then(({ v }) => import("${entry}?v=" + v));
</script>`);
    await writeFile(file, html);
    htmlCount++;
  }
}
await writeFile(join(OUT, "version.json"), JSON.stringify({ v: VERSION }));
console.log(`built _site/ at version ${VERSION}: ${jsCount} modules, ${htmlCount} pages`);
