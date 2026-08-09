export type PatchOperation = 'add' | 'update' | 'delete' | 'move';
export type PatchLineKind = 'context' | 'add' | 'remove';

export type PatchLine = {
  kind: PatchLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

export type PatchFileSection = {
  operation: PatchOperation;
  path: string;
  moveTo?: string;
  lines: PatchLine[];
};

export type ApplyPatchModel =
  | { kind: 'patch'; files: PatchFileSection[] }
  | { kind: 'fallback'; content: string };

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/;
const NUMERIC_HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/;
const STRIPPED_HUNK = /^@@(?:\s.*)?$/;

export function parseApplyPatch(patchText: string): ApplyPatchModel {
  try {
    const lines = patchText.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') {
      return { kind: 'fallback', content: patchText };
    }

    const files: PatchFileSection[] = [];
    let current: PatchFileSection | null = null;
    let oldLine = 1;
    let newLine = 1;
    let sawHunk = false;

    for (let index = 1; index < lines.length - 1; index += 1) {
      const line = lines[index];
      const fileMatch = FILE_HEADER.exec(line);
      if (fileMatch) {
        const operation = fileMatch[1].toLowerCase() as Exclude<PatchOperation, 'move'>;
        current = { operation, path: fileMatch[2], lines: [] };
        files.push(current);
        oldLine = 1;
        newLine = 1;
        sawHunk = false;
        continue;
      }

      if (!current) {
        if (line === '') continue;
        return { kind: 'fallback', content: patchText };
      }

      const moveMatch = MOVE_HEADER.exec(line);
      if (moveMatch && current.operation === 'update' && current.lines.length === 0) {
        current.operation = 'move';
        current.moveTo = moveMatch[1];
        continue;
      }

      if (line.startsWith('@@')) {
        const hunkMatch = NUMERIC_HUNK.exec(line);
        if (hunkMatch) {
          oldLine = Number(hunkMatch[1]);
          newLine = Number(hunkMatch[2]);
        } else if (!STRIPPED_HUNK.test(line) || /^@@\s+[-+]/.test(line)) {
          return { kind: 'fallback', content: patchText };
        }
        sawHunk = true;
        continue;
      }

      if (line.startsWith('+')) {
        current.lines.push({ kind: 'add', content: line.slice(1), oldLine: null, newLine });
        newLine += 1;
      } else if (line.startsWith('-')) {
        current.lines.push({ kind: 'remove', content: line.slice(1), oldLine, newLine: null });
        oldLine += 1;
      } else if (line.startsWith(' ')) {
        current.lines.push({ kind: 'context', content: line.slice(1), oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      } else if (line === '' && !sawHunk && current.lines.length === 0) {
        // Empty file operations have no body.
      } else {
        return { kind: 'fallback', content: patchText };
      }
    }

    return files.length > 0 ? { kind: 'patch', files } : { kind: 'fallback', content: patchText };
  } catch {
    return { kind: 'fallback', content: patchText };
  }
}
