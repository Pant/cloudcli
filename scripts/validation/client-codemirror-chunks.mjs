import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const CODEMIRROR_ARTIFACT = /(?:^|[\\/\-_.])(?:codemirror|code-editor|prd-editor|merge|minimap)(?:[\-_.]|$)/i;
const STATIC_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const STATIC_IMPORT_FROM = /\b(?:import|export)\s*[^"'`;]*?\bfrom\s*["']([^"']+)["']/g;

async function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

function staticImports(source, importer) {
  const imports = [];
  for (const pattern of [STATIC_IMPORT, STATIC_IMPORT_FROM]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.')) imports.push(resolve(dirname(importer), match[1]));
    }
  }
  return imports;
}

export async function validateCodeMirrorChunks(targetDirectory = 'dist') {
  const target = resolve(targetDirectory);
  if (!(await stat(target).catch(() => null))?.isDirectory()) {
    throw new Error(`Client bundle directory does not exist: ${target}`);
  }

  const files = (await collectJavaScriptFiles(target)).sort();
  if (files.length === 0) throw new Error(`No JavaScript files found under: ${target}`);
  const fileSet = new Set(files);
  const graph = new Map(await Promise.all(files.map(async (path) => [
    path,
    staticImports(await readFile(path, 'utf8'), path).filter((dependency) => fileSet.has(dependency)),
  ])));

  const state = new Map();
  const stack = [];
  const cycles = [];
  const seenCycles = new Set();
  const visit = (path) => {
    state.set(path, 1);
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) {
      if (!state.has(dependency)) visit(dependency);
      else if (state.get(dependency) === 1) {
        const cycle = [...stack.slice(stack.indexOf(dependency)), dependency];
        if (cycle.some((entry) => CODEMIRROR_ARTIFACT.test(relative(target, entry)))) {
          const key = [...new Set(cycle)].sort().join('\0');
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            cycles.push(cycle);
          }
        }
      }
    }
    stack.pop();
    state.set(path, 2);
  };
  for (const file of files) if (!state.has(file)) visit(file);

  if (cycles.length > 0) {
    const details = cycles.map((cycle) => `  ${cycle.map((path) => relative(target, path)).join(' -> ')}`).join('\n');
    throw new Error(`Circular static imports involving CodeMirror client artifacts:\n${details}`);
  }

  const related = files.filter((path) => CODEMIRROR_ARTIFACT.test(relative(target, path))).length;
  console.log(`CodeMirror chunk graph passed: ${files.length} JavaScript files; ${related} CodeMirror-related artifacts; no static-import cycles.`);
  return graph;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  validateCodeMirrorChunks(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
