export const languageAliases = {
  bash: 'bash', shell: 'bash', sh: 'bash',
  css: 'css',
  html: 'markup', markup: 'markup',
  javascript: 'javascript', js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  markdown: 'markdown', md: 'markdown',
  python: 'python', py: 'python',
  sql: 'sql',
  typescript: 'typescript', ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml', yml: 'yaml',
} as const;

export const getControlledMarkdownLanguage = (language?: string) =>
  language ? languageAliases[language.toLowerCase() as keyof typeof languageAliases] : undefined;
