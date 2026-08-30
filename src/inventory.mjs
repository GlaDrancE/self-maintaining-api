// Walk the target repo's AST and record every place it talks to a watched API.
// AST rather than grep, so `stripe.charges.create` resolves as a call and a string
// that merely mentions "/pets" does not.
import { Project, SyntaxKind, Node } from 'ts-morph';
import { relative } from 'node:path';

const HTTP_CALLERS = ['fetch', 'axios', 'got', 'ky', 'request'];
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// `/pets/{id}` and `/pets/${id}` both collapse to `/pets/{}` so they compare equal.
export const shape = (path) => path.replace(/\{[^}]*\}/g, '{}');

const posix = (p) => p.split('\\').join('/');

export function scan(cfg) {
const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  project.addSourceFilesAtPaths([
    `${cfg.repoPath}/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}`,
    `!${cfg.repoPath}/**/node_modules/**`,
  ]);

  const sites = [];
  const unresolved = [];
  for (const file of project.getSourceFiles()) {
    const rel = posix(relative(cfg.repoPath, file.getFilePath()));
    for (const api of cfg.apis) {
      collectHttp(file, rel, api, sites, unresolved);
      if (api.sdk) collectSdk(file, rel, api, sites);
    }
  }
  const all = [...sites, ...callersOf(sites, cfg)];
  // `_node` is an AST handle, useful only during the scan and not serialisable.
  return { sites: all.map(({ _node, ...site }) => site), unresolved };
}

// One hop out from each request: the function that wraps it, and everything that
// calls that function. Without this, a removed response field looks like it only
// touches the file holding the `fetch` -- while the tests and callers asserting the
// old shape sit somewhere else entirely and quietly break.
// ponytail: one hop. Deeper chains need a real call graph; one hop already catches
// the wrapper-plus-its-tests case that matters in practice.
function callersOf(sites, cfg) {
  const out = [];
  const seen = new Set(sites.map((s) => `${s.file}:${s.line}`));

  for (const site of sites) {
    if (!site._node) continue;
    const name = enclosingName(site._node);
    if (!name) continue;

    let refs = [];
    try {
      refs = name.findReferencesAsNodes();
    } catch {
      continue; // no language service for this file -- skip rather than fail the scan
    }

    for (const ref of refs) {
      const file = posix(relative(cfg.repoPath, ref.getSourceFile().getFilePath()));
      const line = ref.getStartLineNumber();
      const key = `${file}:${line}`;
      if (seen.has(key)) continue;
      // Imports and re-exports are plumbing, not usage.
      if (ref.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue;
      if (ref.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)) continue;
      seen.add(key);
      out.push({
        api: site.api,
        kind: 'caller',
        via: name.getText(),
        method: site.method,
        path: site.path,
        symbol: site.symbol,
        file,
        line,
        snippet: snippet(ref.getParentWhile((p) => !Node.isStatement(p)) ?? ref),
      });
    }
  }
  return out;
}

// The name of the function a node lives inside, whether declared or assigned.
function enclosingName(node) {
  const fn = node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isMethodDeclaration(a) ||
      (Node.isVariableDeclaration(a) && Node.isFunctionLikeDeclaration(a.getInitializer())),
  );
  return fn?.getNameNode?.() ?? null;
}

// --- HTTP call sites --------------------------------------------------------

function collectHttp(file, rel, api, sites, unresolved) {
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    const root = callee.split('.')[0];
    if (!HTTP_CALLERS.includes(root)) continue;

    const args = call.getArguments();
    if (!args.length) continue;

    const raw = urlOf(args[0]);
    if (raw === null) {
      unresolved.push({ file: rel, line: call.getStartLineNumber(), snippet: snippet(call) });
      continue;
    }

    const path = toPath(raw, api.baseUrl);
    if (path === null) continue;

    sites.push({
      api: api.name,
      kind: 'http',
      method: methodOf(callee, args[1]),
      path,
      file: rel,
      line: call.getStartLineNumber(),
      snippet: snippet(call),
      _node: call,
    });
  }
}

// A URL argument we can reason about, or null if it is computed at runtime.
function urlOf(arg) {
  const kind = arg.getKind();
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return arg.getLiteralText();
  }
  if (kind === SyntaxKind.TemplateExpression) {
    // Every `${...}` becomes `{}` — a path variable, whatever it evaluates to.
    const head = arg.getHead().getLiteralText();
    return arg.getTemplateSpans().reduce((acc, span) => acc + '{}' + span.getLiteral().getLiteralText(), head);
  }
  if (kind === SyntaxKind.ObjectLiteralExpression) {
    const prop = arg.getProperty('url');
    return prop ? urlOf(prop.getInitializer()) : null;
  }
  return null;
}

// Turn a URL expression into a spec-comparable path, or null if it belongs to
// some other host.
function toPath(raw, baseUrl) {
  let s = raw.split('?')[0].split('#')[0];
  if (baseUrl && s.startsWith(baseUrl)) s = s.slice(baseUrl.length);
  // `${BASE}/pets` arrives as `{}/pets` — the leading `{}` is the origin.
  else if (s.startsWith('{}')) s = s.slice(2);
  else if (/^https?:/.test(s)) return null;
  if (!s.startsWith('/')) return null;
  return s.replace(/\/+$/, '') || '/';
}

function methodOf(callee, optionsArg) {
  const verb = callee.split('.').at(-1);
  if (VERBS.includes(verb)) return verb.toUpperCase();
  if (optionsArg?.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const prop = optionsArg.getProperty('method');
    const init = prop?.getInitializer();
    if (init?.getKind() === SyntaxKind.StringLiteral) return init.getLiteralText().toUpperCase();
  }
  return 'GET';
}

// --- SDK call sites ---------------------------------------------------------

function collectSdk(file, rel, api, sites) {
  const roots = new Set();
  for (const imp of file.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== api.sdk) continue;
    const def = imp.getDefaultImport();
    if (def) roots.add(def.getText());
    for (const named of imp.getNamedImports()) roots.add((named.getAliasNode() ?? named.getNameNode()).getText());
    const ns = imp.getNamespaceImport();
    if (ns) roots.add(ns.getText());
  }
  if (!roots.size) return;

  // `const octokit = new Octokit()` — the instance is a call site root too.
  for (const decl of file.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (init?.getKind() !== SyntaxKind.NewExpression) continue;
    if (roots.has(init.getExpression().getText())) roots.add(decl.getName());
  }

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const chain = call.getExpression().getText();
    if (!chain.includes('.')) continue;
    if (!roots.has(chain.split('.')[0])) continue;
    sites.push({
      api: api.name,
      kind: 'sdk',
      symbol: chain,
      file: rel,
      line: call.getStartLineNumber(),
      snippet: snippet(call),
    });
  }
}

const snippet = (node) => node.getText().split('\n')[0].trim().slice(0, 120);
