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
export declare function stripMarkdown(markdown: string): string;
/** Opens a block the model wants delivered whole, such as a list or a table. */
export declare const KEEP_OPEN = "<keep>";
/** Closes a block opened by {@link KEEP_OPEN}. */
export declare const KEEP_CLOSE = "</keep>";
/**
 * Longest block kept whole, in characters, even past `replyMaxChars`; a
 * longer one is split like plain text at this length. dsh-weixin-ilink sends
 * up to 2000 characters per message and openclaw-weixin up to 4000.
 */
export declare const KEEP_MAX_CHARS = 2000;
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
export declare function splitReply(text: string, max: number, keepMax?: number): string[];
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
export declare function splitPlain(text: string, max: number): string[];
