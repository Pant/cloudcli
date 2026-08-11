export function hasMarkdownMath(content: string): boolean {
  const withoutEscapedDollars = content.replace(/\\\$/g, '');
  return /\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(withoutEscapedDollars);
}
