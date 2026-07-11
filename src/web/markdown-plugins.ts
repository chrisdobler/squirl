import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

export const markdownRehypePlugins = [rehypeHighlight];

export const markdownRemarkPlugins = [remarkGfm] as const;
