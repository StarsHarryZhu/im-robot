/**
 * Turn a model's final answer into chat-sized plain text: strip Markdown,
 * then split into segments no longer than the configured limit.
 *
 * Source: the Markdown rules are adapted from `@tencent-weixin/openclaw-weixin`
 * 2.4.10, `src/messaging/markdown-filter.ts` (MIT License, Copyright (C) 2026
 * Tencent; full text in THIRD_PARTY_NOTICES.md): images are removed entirely,
 * heading markers are dropped, fenced code keeps its content, and emphasis
 * markers are stripped while their content stays.
 * Changes: a whole-text, line-based filter instead of a streaming state
 * machine, and it strips more, because a family member's chat shows Markdown
 * as literal symbols: every heading level, bold and italic in any script,
 * strikethrough, inline-code backticks, fence lines, block quotes, links
 * (kept as "text (url)"), table pipes and separator rows, and rules; list
 * bullets become "·". The splitter is new: it cuts at sentence ends, then
 * commas and other clause marks of many scripts, counting characters.
 * @module im-robot/reply
 */
/** Strip Markdown syntax, keeping the readable text. */
export function stripMarkdown(markdown) {
    const lines = [];
    let fenced = false;
    for (const raw of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
        if (/^\s*(```|~~~)/u.test(raw)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            lines.push(raw);
            continue;
        }
        let line = raw;
        // Horizontal rules and table separator rows carry no text.
        if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line))
            continue;
        if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line))
            continue;
        line = line.replace(/^\s{0,3}#{1,6}\s+/u, '');
        line = line.replace(/^\s*(>\s?)+/u, '');
        line = line.replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/u, '$1· ');
        if (/^\s*\|.*\|\s*$/u.test(line)) {
            line = line.trim().replace(/^\||\|$/gu, '').split('|').map(cell => cell.trim()).filter(cell => cell !== '').join('  ');
        }
        lines.push(stripInline(line));
    }
    return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}
/** Strip inline syntax from one line. */
function stripInline(line) {
    return line
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
        .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_, text, url) => (text === url ? url : `${text} (${url})`))
        .replace(/`([^`]+)`/gu, '$1')
        .replace(/(\*\*\*|___)(?=\S)(.+?)(?<=\S)\1/gu, '$2')
        .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu, '$2')
        .replace(/(^|[^*\w])\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)/gu, '$1$2')
        .replace(/(^|[^_\w])_(?=\S)([^_]+?)(?<=\S)_(?![_\w])/gu, '$1$2')
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/gu, '$1');
}
/** Closing quotes and brackets that stay with the punctuation before them. */
const CLOSERS = `["'\u201D\u2019\u300D\u300F\uFF09)\\]\u3011\u300B\u3009\u00BB]*`;
/**
 * Where a segment may end, strongest first. Each pattern matches up to and
 * including the break. ASCII `. ! ? , ; :` count only before whitespace or the
 * end, so "3.14", "1,000", "10:30", and URLs are never cut; full-width and
 * other scripts' marks need no space after them.
 */
const BREAKS = [
    // A blank line between paragraphs.
    /\n[^\S\n]*\n\s*/gu,
    // A line break.
    /\n\s*/gu,
    // Sentence ends: CJK full stops and marks, ellipses, Arabic, Devanagari,
    // Ethiopic, Myanmar, and ASCII . ! ? before a space.
    new RegExp(`(?:[\u3002\uFF01\uFF1F\uFF61\uFF0E\u2026\u2025\u061F\u06D4\u0964\u0965\u1362\u104B]+|[.!?]+(?=${CLOSERS}(?:\\s|$)))${CLOSERS}\\s*`, 'gu'),
    // Clause marks: CJK and Arabic commas, enumeration commas, semicolons, and
    // colons, and ASCII , ; : before a space.
    new RegExp(`(?:[\uFF0C\u3001\uFF64\uFE50\uFE51\uFF1B\uFE54\uFF1A\u060C\u061B]+|[,;:]+(?=${CLOSERS}(?:\\s|$)))${CLOSERS}\\s*`, 'gu'),
    // A space between words.
    /\s+/gu,
];
/** Any whitespace: the last resort before cutting through a word or a link. */
const SPACE = [/\s+/gu];
/** The end of the strongest break in `text` that ends within `(floor, limit]` code units, or -1. */
function breakWithin(text, floor, limit, patterns) {
    for (const pattern of patterns) {
        let best = -1;
        for (const match of text.matchAll(pattern)) {
            const start = match.index ?? 0;
            if (start >= limit)
                break;
            // The break's own trailing whitespace may run past the limit; it is trimmed anyway.
            const end = Math.min(start + match[0].length, limit);
            if (end > floor)
                best = end;
        }
        if (best !== -1)
            return best;
    }
    return -1;
}
/** Opens a block the model wants delivered whole, such as a list or a table. */
export const KEEP_OPEN = '<keep>';
/** Closes a block opened by {@link KEEP_OPEN}. */
export const KEEP_CLOSE = '</keep>';
/**
 * Longest block kept whole, in characters, even past `replyMaxChars`; a
 * longer one is split like plain text at this length. dsh-weixin-ilink sends
 * up to 2000 characters per message and openclaw-weixin up to 4000.
 */
export const KEEP_MAX_CHARS = 2000;
/** Both markers, any case, with optional spaces inside the angle brackets. */
const KEEP_MARKER = /<\s*(\/?)\s*keep\s*>/giu;
/**
 * Text in order as alternating plain and kept parts, markers removed. A
 * stray closer or a nested opener is dropped; an unclosed block runs to the
 * end.
 */
function keepParts(text) {
    const parts = [];
    let open = false;
    let current = '';
    let from = 0;
    for (const match of text.matchAll(KEEP_MARKER)) {
        const at = match.index ?? 0;
        current += text.slice(from, at);
        from = at + match[0].length;
        const closing = match[1] === '/';
        if (closing !== open)
            continue;
        if (current !== '')
            parts.push({ text: current, keep: open });
        current = '';
        open = !closing;
    }
    current += text.slice(from);
    if (current !== '')
        parts.push({ text: current, keep: open });
    return parts;
}
/** Characters (code points) in a string. */
function charCount(text) {
    let count = 0;
    for (const _ of text)
        count += 1;
    return count;
}
/** The whitespace a string ends with. */
function trailingSpace(text) {
    return /\s*$/u.exec(text)?.[0] ?? '';
}
/**
 * Split text into segments of at most `max` characters (code points, so an
 * emoji counts as one). A block between {@link KEEP_OPEN} and
 * {@link KEEP_CLOSE} is never split: it shares a segment with the text before
 * and after it when everything fits, and otherwise starts a segment of its
 * own, which may run past `max` up to `keepMax` (a longer block is split like
 * plain text at `keepMax`). The markers never reach the reader. Plain text is
 * split as {@link splitPlain} does.
 * @param text - plain text, possibly with keep markers.
 * @param max - the longest segment, in characters; at least 1.
 * @param keepMax - the longest block kept whole, in characters.
 * @returns the non-empty, trimmed segments, in order.
 */
export function splitReply(text, max, keepMax = KEEP_MAX_CHARS) {
    const limit = Math.max(1, Math.floor(max));
    const cap = Math.max(limit, Math.floor(keepMax));
    const segments = [];
    // Text not yet emitted, at most `limit` characters once trimmed, with its original spacing.
    let pending = '';
    // Whether `pending` holds a kept block, which must never be split again.
    let holdsBlock = false;
    const flush = () => {
        const segment = pending.trim();
        if (segment !== '')
            segments.push(segment);
        pending = '';
        holdsBlock = false;
    };
    for (const part of keepParts(text)) {
        const together = `${pending}${part.text}`;
        if (part.keep) {
            const block = part.text.trim();
            if (block === '')
                continue;
            if (charCount(together.trim()) <= limit) {
                pending = together;
                holdsBlock = true;
                continue;
            }
            flush();
            const size = charCount(block);
            if (size <= limit) {
                pending = part.text;
                holdsBlock = true;
            }
            else if (size <= cap) {
                segments.push(block);
            }
            else {
                segments.push(...splitPlain(block, cap));
            }
            continue;
        }
        if (holdsBlock) {
            if (charCount(together.trim()) <= limit) {
                pending = together;
                continue;
            }
            flush();
        }
        // `pending` is empty here: plain parts only follow blocks or start the text.
        const pieces = splitPlain(part.text, limit);
        segments.push(...pieces.slice(0, -1));
        // The last piece may still share a segment with a block that follows.
        pending = `${pieces.at(-1) ?? ''}${trailingSpace(part.text)}`;
    }
    flush();
    return segments;
}
/**
 * Split plain text into segments of at most `max` characters. A segment ends
 * at the strongest break within its limit, preferring a paragraph, then a
 * line, then a sentence end, then a comma or other clause mark in any common
 * script, then a space, all within the second half of the window. Without one
 * there, it ends at any earlier space rather than inside a word or link, and
 * is cut hard only when the window has no space at all.
 * @param text - plain text.
 * @param max - the longest segment, in characters; at least 1.
 * @returns the non-empty, trimmed segments, in order.
 */
export function splitPlain(text, max) {
    const limit = Math.max(1, Math.floor(max));
    const segments = [];
    let rest = text.trim();
    while (rest !== '') {
        const chars = Array.from(rest.slice(0, limit * 2 + 2));
        if (chars.length <= limit && rest.length <= chars.join('').length) {
            segments.push(rest);
            break;
        }
        // Code-unit length of the first `limit` characters: a cut there never splits a surrogate pair.
        const window = chars.slice(0, limit).join('').length;
        const floor = Math.floor(chars.slice(0, Math.floor(limit / 2)).join('').length);
        let cut = breakWithin(rest, floor, window, BREAKS);
        if (cut === -1)
            cut = breakWithin(rest, 0, window, SPACE);
        if (cut === -1)
            cut = window;
        const segment = rest.slice(0, cut).trimEnd();
        if (segment !== '')
            segments.push(segment);
        rest = rest.slice(cut).trimStart();
    }
    return segments;
}
