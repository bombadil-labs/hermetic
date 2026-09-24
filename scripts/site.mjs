#!/usr/bin/env node
// Builds the GitHub Pages site into _site/, or the directory given: the
// landing page and the case studies, with every number and example taken from
// site/data/corpus.json, which `npm run corpus -- report` writes. A placeholder
// that names nothing, or an example the report did not record, fails the build.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { createHighlighter } from "shiki";

const root = fileURLToPath(new URL("../", import.meta.url));
const siteDir = path.join(root, "site");
const out = path.resolve(process.argv[2] ?? path.join(root, "_site"));
// The build empties its output directory first, so that must not hold the repository or the site's sources.
const within = (inner, outer) => {
  const relative = path.relative(outer, inner);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
if (within(root, out) || within(out, siteDir)) throw new Error(`Refusing to build into ${out}: the build empties it first`);
const data = JSON.parse(fs.readFileSync(path.join(siteDir, "data", "corpus.json"), "utf8"));
const REPOSITORY = "https://github.com/bombadil-labs/hermetic";

const highlighter = await createHighlighter({ themes: ["github-light", "github-dark"], langs: ["ts", "tsx", "js", "sh"] });
const highlight = (code, lang) =>
  highlighter.codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark" }, defaultColor: "light" });

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const count = (n) => n.toLocaleString("en-US");
const percent = (n, of) => `${((100 * n) / of).toFixed(1)}%`;

// The values placeholders can name, formatted for reading.

const HOISTED = "a declaration that reads unsettled names";
const MEMBERS = "a method or object member";

function library(id) {
  const found = data.libraries.find((entry) => entry.id === id);
  if (!found) throw new Error(`corpus.json has no library "${id}"`);
  return found;
}

function libraryValues(id) {
  const l = library(id);
  const lifted = l.direct + l.shared;
  const reason = (name) => l.reasons.find((entry) => entry.reason === name)?.count ?? 0;
  return {
    name: l.name,
    version: l.packages[0].version,
    packages: l.packages.map((p) => `${p.name}@${p.version}`).join(", "),
    files: count(l.files),
    candidates: count(l.candidates),
    hermetic: count(l.hermetic),
    hermeticPct: percent(l.hermetic, l.candidates),
    hermeticMembers: count(l.hermeticMembers),
    hermeticMembersPct: percent(l.hermeticMembers, l.hermetic),
    lifted: count(lifted),
    liftedPct: percent(lifted, l.candidates),
    direct: count(l.direct),
    directPct: percent(l.direct, l.candidates),
    shared: count(l.shared),
    sharedPct: percent(l.shared, l.candidates),
    skipped: count(l.skipped),
    skippedPct: percent(l.skipped, l.candidates),
    members: count(reason(MEMBERS)),
    membersPctOfSkipped: percent(reason(MEMBERS), l.skipped),
    hoistedSkipped: count(reason(HOISTED)),
    hoistedOnlyImports: count(l.hoistedOnlyImports),
    liftedWithImports: count(lifted + l.hoistedOnlyImports),
    liftedWithImportsPct: percent(lifted + l.hoistedOnlyImports, l.candidates),
    unnamed: count(l.unnamed),
    unnamedDual: count(l.unnamedPassedTo.dual ?? 0),
    changedFiles: count(l.validation.filesChanged),
    typeErrorsIntroduced: count(l.validation.typeErrorsIntroduced),
    folded: count(l.validation.folded),
    roundTripDiffering: count(l.validation.roundTripDiffering),
  };
}

function suiteValues(result, label) {
  if (!result) throw new Error(`corpus.json has no Effect ${label} test-suite results: run npm run corpus -- effect${label === "unlifted" ? " --unlift" : ""}, then report`);
  return { tests: count(result.tests), passed: count(result.passed), failed: count(result.failed), files: count(result.files) };
}

const totals = data.libraries.reduce(
  (sum, l) => ({
    candidates: sum.candidates + l.candidates,
    hermetic: sum.hermetic + l.hermetic,
    lifted: sum.lifted + l.direct + l.shared,
    typeErrorsIntroduced: sum.typeErrorsIntroduced + l.validation.typeErrorsIntroduced,
  }),
  { candidates: 0, hermetic: 0, lifted: 0, typeErrorsIntroduced: 0 },
);

const values = {
  effect: { ...libraryValues("effect"), suite: { lifted: suiteValues(data.effect.lifted, "lifted"), unlifted: suiteValues(data.effect.unlifted, "unlifted") } },
  rxjs: libraryValues("rxjs"),
  tanstack: libraryValues("tanstack-query"),
  total: {
    candidates: count(totals.candidates),
    hermetic: count(totals.hermetic),
    hermeticPct: percent(totals.hermetic, totals.candidates),
    lifted: count(totals.lifted),
    liftedPct: percent(totals.lifted, totals.candidates),
    typeErrorsIntroduced: count(totals.typeErrorsIntroduced),
  },
};

function lookup(key, file) {
  let value = values;
  for (const part of key.split(".")) value = value?.[part];
  if (value === undefined || typeof value === "object") throw new Error(`${file}: {{${key}}} names no value`);
  return String(value);
}

// Generated fragments.

function sourceLink(file) {
  const l = data.libraries.find((entry) => entry.packages.some((p) => file.startsWith(`${p.name}/`)));
  const pkg = l?.packages.find((p) => file.startsWith(`${p.name}/`));
  if (!pkg) throw new Error(`No package for ${file}`);
  return `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/${file.slice(pkg.name.length + 1)}`;
}

function outcomeTag(example) {
  switch (example.outcome) {
    case "hermetic":
      return `<span class="tag">already hermetic: marked</span>`;
    case "direct":
      return `<span class="tag">lifted, values passed directly</span>`;
    case "shared":
      return `<span class="tag">lifted, shared context</span>`;
    default:
      return `<span class="tag skipped">left alone: ${escape(example.reason)}</span>`;
  }
}

function examplePanel(spec, file) {
  const [exampleFile, name] = spec.split("#");
  const example = data.libraries.flatMap((l) => l.examples).find((e) => e.file === exampleFile && e.name === name);
  if (!example) throw new Error(`${file}: the report recorded no example ${spec}; add it to EXAMPLES in scripts/corpus.mjs`);
  const lang = exampleFile.endsWith(".tsx") ? "tsx" : "ts";
  const caption = `<code>${escape(name)}</code> in <a href="${sourceLink(exampleFile)}">${escape(exampleFile)}</a>, line ${example.line} ${outcomeTag(example)}`;
  const pane = (label, code) => `<div class="pane"><p class="pane-label">${label}</p>${highlight(code, lang)}</div>`;
  const panes = example.after
    ? `<div class="panes">${pane("Before", example.before)}${pane("After --fix", example.after)}</div>`
    : `<div class="panes single">${pane("Unchanged", example.before)}</div>`;
  return `<figure class="example"><figcaption>${caption}</figcaption>${panes}</figure>`;
}

function benchTable() {
  const bench = data.effect.bench;
  if (!bench) throw new Error("corpus.json has no benchmark results: run npm run corpus -- bench, then report");
  const change = (ms, base) => `${ms >= base ? "+" : "−"}${Math.abs(Math.round((100 * (ms - base)) / base))}%`;
  const cell = (t, tree) => `<td class="num">${t[tree].toFixed(1)}ms <small>${change(t[tree], t.original)}</small></td>`;
  const rows = Object.entries(bench.workloads).map(
    ([workload, t]) =>
      `<tr><td>${escape(workload)}</td><td class="num">${t.original.toFixed(1)}ms</td>${cell(t, "lifted")}${cell(t, "unlifted")}${cell(t, "control")}</tr>`,
  );
  const caption = [
    `Effect ${escape(library("effect").packages[0].version)} workloads on Node ${escape(bench.node)}: the best median of ${bench.samples} timings across ${bench.processes} processes per copy, run in rotating order.`,
    `The last column is a second copy of the original source, so its distance from the first is noise.`,
  ].join(" ");
  return `<figure class="example"><figcaption>${caption}</figcaption><div class="table-scroll"><table><thead><tr><th>Workload</th><th class="num">Original</th><th class="num">Lifted</th><th class="num">Unlifted</th><th class="num">Original again</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></figure>`;
}

function reasonsTable(id) {
  const l = library(id);
  const rows = l.reasons.map(
    (entry) => `<tr><td>${escape(entry.reason)}</td><td class="num">${count(entry.count)}</td><td class="num">${percent(entry.count, l.skipped)}</td></tr>`,
  );
  return `<div class="table-scroll"><table><thead><tr><th>Why it was left alone</th><th class="num">Functions</th><th class="num">Share</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function outcomeBar(id) {
  const l = library(id);
  const lifted = l.direct + l.shared;
  const width = (n) => `${((100 * n) / l.candidates).toFixed(2)}%`;
  return [
    `<div class="bar" role="img" aria-label="${escape(`${l.name}: ${percent(l.hermetic, l.candidates)} already hermetic, ${percent(lifted, l.candidates)} lifted, ${percent(l.skipped, l.candidates)} left alone`)}">`,
    `<span class="hermetic" style="width:${width(l.hermetic)}"></span><span class="lifted" style="width:${width(lifted)}"></span></div>`,
    `<div class="legend"><span><i style="background:var(--accent)"></i>Already hermetic ${percent(l.hermetic, l.candidates)}</span>`,
    `<span><i style="background:color-mix(in srgb, var(--accent) 45%, var(--bg))"></i>Lifted ${percent(lifted, l.candidates)}</span>`,
    `<span><i style="background:var(--line)"></i>Left alone ${percent(l.skipped, l.candidates)}</span></div>`,
  ].join("");
}

/** Fills `{{placeholders}}` with values. */
function fill(text, file) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => escape(lookup(key, file)));
}

/**
 * Expands fragment comments into HTML and highlights every `<pre data-lang>`.
 * Runs after Markdown, which passes comments through: highlighted code keeps
 * its blank lines, and a blank line would end a raw HTML block.
 */
function expand(html, file) {
  return html
    .replace(/<!-- example ([^ ]+) -->/g, (_, spec) => examplePanel(spec, file))
    .replace(/<!-- bench -->/g, () => benchTable())
    .replace(/<!-- reasons ([\w-]+) -->/g, (_, id) => reasonsTable(id))
    .replace(/<!-- outcomes ([\w-]+) -->/g, (_, id) => outcomeBar(id))
    .replace(/<pre data-lang="(\w+)">([\s\S]*?)<\/pre>/g, (_, lang, code) => highlight(unescape(code), lang));
}

function unescape(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// Layout.

const CASE_STUDIES = [
  { id: "effect", title: "Effect" },
  { id: "rxjs", title: "RxJS" },
  { id: "tanstack-query", title: "TanStack Query" },
];

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12.5" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="16" r="5.5" fill="currentColor"/></svg>`;

function header(base, current) {
  const links = CASE_STUDIES.map(
    (study) => `<a href="${base}case-studies/${study.id}.html"${study.id === current ? ' aria-current="page"' : ""}>${study.title}</a>`,
  );
  return `<header class="site-header"><div class="wrap"><a class="brand" href="${base}index.html">${LOGO}hermetic</a><nav class="site-nav" aria-label="Site">${links.join("")}<a href="${REPOSITORY}">GitHub</a></nav></div></header>`;
}

function footer() {
  return [
    `<footer class="site-footer"><div class="wrap">`,
    `<span>MIT licensed. Every number comes from <code>npm run corpus</code> at <a href="${REPOSITORY}/commit/${escape(data.generated.commit)}">${escape(data.generated.commit)}</a>${data.generated.dirty ? " with uncommitted changes" : ""}, ${escape(data.generated.date.slice(0, 10))}.</span>`,
    `<span><a href="${REPOSITORY}">GitHub</a> · <a href="https://www.npmjs.com/package/@bombadil/hermetic">npm</a></span>`,
    `</div></footer>`,
    `<script>for (const button of document.querySelectorAll("[data-copy]")) button.addEventListener("click", () => navigator.clipboard?.writeText(button.dataset.copy).then(() => { button.textContent = "Copied"; setTimeout(() => (button.textContent = "Copy"), 1500); }));</script>`,
  ].join("");
}

// Markdown: code blocks are highlighted, headings get ids, tables scroll on narrow screens.

const slug = (text) => text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} id="${slug(text)}">${text}</h${depth}>\n`;
    },
    code({ text, lang }) {
      return highlight(text, lang && highlighter.getLoadedLanguages().includes(lang) ? lang : "text");
    },
    table(token) {
      return `<div class="table-scroll">${marked.Renderer.prototype.table.call(this, token)}</div>`;
    },
  },
});

function caseStudy(study) {
  const file = path.join(siteDir, "case-studies", `${study.id}.md`);
  const source = fs.readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error(`${file}: no front matter`);
  const meta = Object.fromEntries(match[1].split("\n").map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));
  const body = expand(marked.parse(fill(source.slice(match[0].length), file)), file);
  const others = CASE_STUDIES.filter((other) => other.id !== study.id).map(
    (other) => `<a class="card link" href="${other.id}.html"><span class="kicker">Case study</span><h3>${other.title}</h3><span class="more">Read it →</span></a>`,
  );
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<title>${fill(meta.title, file)}</title><meta name="description" content="${fill(meta.description, file)}" />`,
    `<link rel="icon" href="../favicon.svg" type="image/svg+xml" /><link rel="stylesheet" href="../style.css" /></head><body>`,
    header("../", study.id),
    `<main class="article"><div class="wrap"><p class="eyebrow">Case study</p>${body}<div class="next">${others.join("")}<a class="card link" href="../index.html"><span class="kicker">Hermetic functions</span><h3>Back to the overview</h3><span class="more">Home →</span></a></div></div></main>`,
    footer(),
    `</body></html>`,
  ].join("");
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "case-studies"), { recursive: true });
const index = fs.readFileSync(path.join(siteDir, "index.html"), "utf8").replace("<!-- header -->", header("", undefined)).replace("<!-- footer -->", footer());
fs.writeFileSync(path.join(out, "index.html"), expand(fill(index, "site/index.html"), "site/index.html"));
for (const study of CASE_STUDIES) fs.writeFileSync(path.join(out, "case-studies", `${study.id}.html`), caseStudy(study));
for (const asset of ["style.css", "favicon.svg"]) fs.copyFileSync(path.join(siteDir, asset), path.join(out, asset));
for (const written of [path.join(out, "index.html"), ...CASE_STUDIES.map((study) => path.join(out, "case-studies", `${study.id}.html`))]) {
  const html = fs.readFileSync(written, "utf8");
  if (/\{\{|<!-- (example|bench|reasons|outcomes)/.test(html)) throw new Error(`${written} still has an unresolved placeholder`);
}
console.log(`Built the site in ${path.relative(process.cwd(), out) || "."}`);
