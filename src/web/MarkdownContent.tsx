import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { ExtraProps } from 'react-markdown';
import { JsonViewer } from './JsonViewer.js';
import { extractCodeText, isJsonLanguage, parseJsonBlock, type HastLike } from './json-block.js';
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdown-plugins.js';

function MarkdownCode(props: React.ComponentProps<'code'> & ExtraProps) {
  const { className, children, node, ...rest } = props;
  const match = /language-([\w-]+)/.exec(className ?? '');
  const lang = match?.[1]?.toLowerCase();

  if (lang && isJsonLanguage(lang)) {
    const raw = extractCodeText(node as HastLike | undefined);
    const parsed = parseJsonBlock(raw, lang);
    if (parsed !== null) {
      return <JsonViewer value={parsed} lang={lang} />;
    }
  }

  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

export interface MarkdownContentProps {
  children: string;
}

export function areMarkdownContentPropsEqual(previous: MarkdownContentProps, next: MarkdownContentProps): boolean {
  return previous.children === next.children;
}

export const MarkdownContent = React.memo(function MarkdownContent({ children }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[...markdownRemarkPlugins]}
      rehypePlugins={[...markdownRehypePlugins]}
      components={{ code: MarkdownCode }}
    >
      {children}
    </ReactMarkdown>
  );
}, areMarkdownContentPropsEqual);
