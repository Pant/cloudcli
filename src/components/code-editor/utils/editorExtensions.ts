import { StreamLanguage } from '@codemirror/language';
import type { Extension, EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

import type { CodeEditorFile } from '../types/types';

type MergeChunk = { fromB: number; toB: number };
export type GetMergeChunks = (state: EditorState) => { chunks?: readonly MergeChunk[] } | null;

export type MergeCapability = {
  createExtension: (original: string) => Extension;
  getChunks: GetMergeChunks;
};

export type CapabilityRequest = {
  isCurrent: () => boolean;
};

export const createCapabilityRequest = (sequence: { current: number }): CapabilityRequest => {
  const request = ++sequence.current;
  return {
    isCurrent: () => request === sequence.current,
  };
};

let mergeCapabilityPromise: Promise<MergeCapability> | null = null;
let minimapModulePromise: Promise<typeof import('@replit/codemirror-minimap')> | null = null;

// Lightweight lexer for `.env` files (including `.env.*` variants).
const envLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.match(/^#.*/)) return 'comment';
    if (stream.sol() && stream.match(/^[A-Za-z_][A-Za-z0-9_.]*(?==)/)) return 'variableName.definition';
    if (stream.match(/^=/)) return 'operator';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\$\{[^}]*\}?/)) return 'variableName.special';
    if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName.special';
    if (stream.match(/^\d+/)) return 'number';

    stream.next();
    return null;
  },
});

export const loadLanguageExtensions = async (filename: string): Promise<Extension[]> => {
  const lowerName = filename.toLowerCase();
  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return [envLanguage];
  }

  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return [(await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: ext.includes('ts') })];
    case 'py':
      return [(await import('@codemirror/lang-python')).python()];
    case 'html':
    case 'htm':
      return [(await import('@codemirror/lang-html')).html()];
    case 'css':
    case 'scss':
    case 'less':
      return [(await import('@codemirror/lang-css')).css()];
    case 'json':
      return [(await import('@codemirror/lang-json')).json()];
    case 'md':
    case 'markdown':
      return [(await import('@codemirror/lang-markdown')).markdown()];
    case 'env':
      return [envLanguage];
    default:
      return [];
  }
};

export const loadMergeCapability = async (): Promise<MergeCapability> => {
  mergeCapabilityPromise ??= import('@codemirror/merge').then(({ getChunks, unifiedMergeView }) => ({
    getChunks,
    createExtension: (original) => unifiedMergeView({
      original,
      mergeControls: false,
      highlightChanges: true,
      syntaxHighlightDeletions: false,
      gutter: true,
    }),
  }));
  return mergeCapabilityPromise;
};

export const loadMinimapExtension = async ({
  file,
  showDiff,
  minimapEnabled,
  isDarkMode,
}: {
  file: CodeEditorFile;
  showDiff: boolean;
  minimapEnabled: boolean;
  isDarkMode: boolean;
}, getChunks: GetMergeChunks): Promise<Extension[]> => {
  if (!file.diffInfo || !showDiff || !minimapEnabled) {
    return [];
  }

  minimapModulePromise ??= import('@replit/codemirror-minimap');
  const { showMinimap } = await minimapModulePromise;
  const gutters: Record<number, string> = {};

  return [
    showMinimap.compute(['doc'], (state) => {
      const chunksData = getChunks(state);
      const chunks = chunksData?.chunks || [];

      Object.keys(gutters).forEach((key) => {
        delete gutters[Number(key)];
      });

      chunks.forEach((chunk) => {
        const fromLine = state.doc.lineAt(chunk.fromB).number;
        const toLine = state.doc.lineAt(Math.min(chunk.toB, state.doc.length)).number;

        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
          gutters[lineNumber] = isDarkMode ? 'rgba(34, 197, 94, 0.8)' : 'rgba(34, 197, 94, 1)';
        }
      });

      return {
        create: () => ({ dom: document.createElement('div') }),
        displayText: 'blocks',
        showOverlay: 'always',
        gutters: [gutters],
      };
    }),
  ];
};

export const createScrollToFirstChunkExtension = ({
  file,
  showDiff,
}: {
  file: CodeEditorFile;
  showDiff: boolean;
}, getChunks: GetMergeChunks) => {
  if (!file.diffInfo || !showDiff) {
    return [];
  }

  return [
    ViewPlugin.fromClass(class {
      private destroyed = false;

      constructor(view: EditorView) {
        // Wait for merge decorations so the first chunk location is stable.
        setTimeout(() => {
          if (this.destroyed) return;
          const chunksData = getChunks(view.state);
          const firstChunk = chunksData?.chunks?.[0];

          if (firstChunk) {
            view.dispatch({
              effects: EditorView.scrollIntoView(firstChunk.fromB, { y: 'center' }),
            });
          }
        }, 100);
      }

      update() {}

      destroy() {
        this.destroyed = true;
      }
    }),
  ];
};
