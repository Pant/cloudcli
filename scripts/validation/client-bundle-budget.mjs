import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createGzip } from 'node:zlib';

export const MAX_GZIP_BYTES = 100_000;
// Initial resources referenced by dist/index.html. Keep these explicit and deterministic.
export const MAX_INITIAL_JS_GZIP_BYTES = 350_000;
export const MAX_INITIAL_CSS_GZIP_BYTES = 80_000;
export const MAX_INITIAL_TOTAL_GZIP_BYTES = 430_000;

async function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

async function gzipSize(path) {
  let bytes = 0;
  const gzip = createGzip();
  gzip.on('data', (chunk) => { bytes += chunk.length; });
  await new Promise((resolveStream, reject) => {
    createReadStream(path).on('error', reject).pipe(gzip)
      .on('error', reject).on('end', resolveStream).resume();
  });
  return bytes;
}

export async function validateClientBundle(targetDirectory = 'dist') {
  const target = resolve(targetDirectory);
  if (!(await stat(target).catch(() => null))?.isDirectory()) {
    throw new Error(`Client bundle directory does not exist: ${target}`);
  }

  const files = (await collectJavaScriptFiles(target)).sort();
  if (files.length === 0) throw new Error(`No JavaScript files found under: ${target}`);

  const results = await Promise.all(files.map(async (path) => ({ path, bytes: await gzipSize(path) })));
  const offenders = results.filter(({ bytes }) => bytes > MAX_GZIP_BYTES);
  if (offenders.length > 0) {
    const details = offenders.map(({ path, bytes }) => `  ${relative(target, path)}: ${bytes} bytes gzip`).join('\n');
    throw new Error(`Client bundle gzip budget exceeded (maximum ${MAX_GZIP_BYTES} bytes):\n${details}`);
  }

  const largest = results.reduce((max, result) => result.bytes > max.bytes ? result : max);
  const html = await readFile(resolve(target, 'index.html'), 'utf8');
  const initialPaths = [...html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+\.(?:js|css))["']/g)]
    .map((match) => match[1].replace(/^\.\//, '').replace(/^\//, ''));
  const initial = await Promise.all(initialPaths.map(async (path) => ({ path, bytes: await gzipSize(resolve(target, path)) })));
  const initialJs = initial.filter(({ path }) => path.endsWith('.js')).reduce((sum, item) => sum + item.bytes, 0);
  const initialCss = initial.filter(({ path }) => path.endsWith('.css')).reduce((sum, item) => sum + item.bytes, 0);
  const initialTotal = initialJs + initialCss;
  const aggregateFailures = [
    initialJs > MAX_INITIAL_JS_GZIP_BYTES && `initial JavaScript ${initialJs} > ${MAX_INITIAL_JS_GZIP_BYTES}`,
    initialCss > MAX_INITIAL_CSS_GZIP_BYTES && `initial CSS ${initialCss} > ${MAX_INITIAL_CSS_GZIP_BYTES}`,
    initialTotal > MAX_INITIAL_TOTAL_GZIP_BYTES && `initial total ${initialTotal} > ${MAX_INITIAL_TOTAL_GZIP_BYTES}`,
  ].filter(Boolean);
  if (aggregateFailures.length) throw new Error(`Client aggregate gzip budget exceeded:\n  ${aggregateFailures.join('\n  ')}`);
  console.log(`Client bundle budget passed: ${files.length} JavaScript files; largest ${relative(target, largest.path)} at ${largest.bytes} bytes gzip (limit ${MAX_GZIP_BYTES}). Initial JS ${initialJs}/${MAX_INITIAL_JS_GZIP_BYTES}, CSS ${initialCss}/${MAX_INITIAL_CSS_GZIP_BYTES}, total ${initialTotal}/${MAX_INITIAL_TOTAL_GZIP_BYTES} bytes gzip.`);
  return results;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  validateClientBundle(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
