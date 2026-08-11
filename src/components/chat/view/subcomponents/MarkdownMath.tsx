import type React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

export default function MarkdownMath({ children, className, breaks, components }: {
  children: string;
  className?: string;
  breaks: boolean;
  components: Record<string, React.ComponentType<any> | keyof React.JSX.IntrinsicElements>;
}) {
  const remarkPlugins = breaks
    ? [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkBreaks]
    : [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
  return <div className={className}><ReactMarkdown remarkPlugins={remarkPlugins as any} rehypePlugins={[rehypeKatex]} components={components as any}>{children}</ReactMarkdown></div>;
}
