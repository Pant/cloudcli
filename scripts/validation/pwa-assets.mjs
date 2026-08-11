import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const parseSize = (value) => {
  const match = /^(\d+)x(\d+)$/.exec(value ?? '');
  return match ? [Number(match[1]), Number(match[2])] : null;
};

export async function validateManifest(manifest, readResource) {
  const errors = [];
  if (manifest.id !== './' || manifest.start_url !== './' || manifest.scope !== './') errors.push('id, start_url, and scope must all be relative ./ URLs');
  if ('orientation' in manifest) errors.push('manifest must not force an orientation');
  if (!manifest.name?.includes('CloudCLI') || /claude ui/i.test(JSON.stringify(manifest))) errors.push('manifest branding must be CloudCLI');
  const icons = manifest.icons ?? [];
  const purposes = new Set(icons.map((icon) => icon.purpose));
  if (!purposes.has('any') || !purposes.has('maskable')) errors.push('separate ordinary and maskable icons are required');
  const declaredByPurpose = new Map();
  for (const [kind, entries] of [['icon', icons], ['screenshot', manifest.screenshots ?? []]]) {
    for (const entry of entries) {
      const declared = parseSize(entry.sizes);
      if (!declared) { errors.push(`${kind} ${entry.src} has an invalid sizes value`); continue; }
      try {
        const buffer = await readResource(entry.src);
        const metadata = await sharp(buffer).metadata();
        if (metadata.width !== declared[0] || metadata.height !== declared[1]) errors.push(`${entry.src} is ${metadata.width}x${metadata.height}, declared ${entry.sizes}`);
        if (MIME_BY_FORMAT[metadata.format] !== entry.type) errors.push(`${entry.src} is ${MIME_BY_FORMAT[metadata.format] ?? metadata.format}, declared ${entry.type}`);
        if (kind === 'icon') {
          const key = `${entry.purpose}:${metadata.width}x${metadata.height}`;
          if (declaredByPurpose.has(key)) errors.push(`${entry.src} duplicates physical icon size ${key}`);
          declaredByPurpose.set(key, entry.src);
        }
      } catch (error) { errors.push(`${entry.src} cannot be read: ${error.message}`); }
    }
  }
  return errors;
}

export async function validateDirectory(directory) {
  const manifestPath = path.join(directory, 'manifest.json');
  await access(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return validateManifest(manifest, (src) => readFile(path.join(directory, src)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) targets.push('public');
  let failed = false;
  for (const target of targets) {
    const directory = path.resolve(target);
    const errors = await validateDirectory(directory);
    if (errors.length) { failed = true; console.error(`${target}:\n- ${errors.join('\n- ')}`); }
    else console.log(`${target}: PWA assets valid`);
  }
  if (failed) process.exitCode = 1;
}
