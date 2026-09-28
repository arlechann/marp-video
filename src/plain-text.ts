import MarkdownIt, { type Token } from 'markdown-it';

const markdown = new MarkdownIt('commonmark', { html: true });

const inlineText = (tokens: readonly Token[], pageNumber: number): string =>
    tokens
        .map(token => {
            if (token.type === 'html_inline') {
                throw new Error(`${pageNumber}ページ目に使用できない生のHTMLがあります`);
            }
            if (token.type === 'text' || token.type === 'text_special' || token.type === 'code_inline') {
                return token.content;
            }
            if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
            if (token.type === 'image') {
                // Only the alternative text is spoken; image URLs are not narration.
                return token.children ? inlineText(token.children, pageNumber) : token.content;
            }
            // Link and emphasis tokens describe structure; their child text is emitted separately.
            return '';
        })
        .join('');

export const markdownToPlainText = (source: string, pageNumber: number): string => {
    const blocks = markdown.parse(source, {}).flatMap(token => {
        if (token.type === 'html_block') {
            throw new Error(`${pageNumber}ページ目に使用できない生のHTMLがあります`);
        }
        if (token.type === 'inline') return [inlineText(token.children ?? [], pageNumber)];
        if (token.type === 'fence' || token.type === 'code_block') return [token.content.replace(/\n+$/, '')];
        // Horizontal rules, list markers, and block wrappers have no spoken text.
        return [];
    });
    const text = blocks
        .filter(block => block.trim() !== '')
        .join('\n')
        .trim();
    if (text === '') throw new Error(`${pageNumber}ページ目の読み上げテキストが空です`);
    return text;
};
