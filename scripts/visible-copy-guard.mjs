/*
 * Finds retired wording in text a person can see in the web app.
 *
 * "Visible text" here is every string literal, every piece of a template
 * literal, and every run of JSX text in `apps/web/src`. Comments are not, and
 * that is the point of parsing instead of grepping: the code and its comments
 * keep domain terms on purpose (a Saved for Later task is still called that in
 * code, per CONTEXT.md and ADR-0011) while the screen uses a different label.
 * A plain grep cannot tell the two apart.
 *
 * It over-reports rather than under-reports. A string that never reaches the
 * screen (a storage key, a log line) still counts, because the cheapest way to
 * keep a retired label off the screen is to keep it out of strings entirely.
 *
 * To retire another phrase, add a row to RETIRED_COPY: what to match, what the
 * screen says instead, and why. The sim test reads the table, so a new row is
 * guarded the moment it lands.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const RETIRED_COPY = [
  {
    phrase: /saved for later/i,
    use: "Task Draft",
    why:
      "The board shows these on the Task Drafts tab (#363), so the screen calls one a Task Draft (#384). " +
      "Never a bare \"draft\": that word already means the form's Autosave. " +
      "\"Save for later\", the button, is a different phrase and stays."
  }
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/* Every .ts/.tsx file under `dir`, sorted. */
const sourceFiles = (dir) => {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
    }
  }
  return found.sort();
};

/* The visible text in one file's source: [{ line, text }], line 1-based. */
export const visibleText = (source, fileName = "fixture.tsx") => {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found = [];
  const visit = (node) => {
    let text = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
    else if (ts.isJsxText(node)) text = node.text;
    if (text !== null && text.trim()) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push({ line: line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

/* Retired phrases in one file's source: [{ line, text, use }].
   Matched with whitespace runs collapsed to one space, the way the screen
   renders JSX text a formatter wrapped mid-phrase, so a phrase is written
   with plain spaces and still catches "Saved for\n    Later". */
export const retiredCopyIn = (source, fileName, retired = RETIRED_COPY) =>
  visibleText(source, fileName).flatMap(({ line, text }) => {
    const onScreen = text.replace(/\s+/g, " ");
    return retired.filter((rule) => rule.phrase.test(onScreen)).map((rule) => ({ line, text: onScreen, use: rule.use }));
  });

/* Retired phrases across a source tree: [{ file, line, text, use }], file relative to `dir`. */
export const retiredCopyUnder = (dir, retired = RETIRED_COPY) =>
  sourceFiles(dir).flatMap((file) =>
    retiredCopyIn(fs.readFileSync(file, "utf8"), file, retired).map((hit) => ({
      file: path.relative(dir, file),
      ...hit
    }))
  );
