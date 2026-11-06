/**
 * Turn the files a chat message brought into prompt parts the host's
 * conversation view shows: an image goes into the prompt itself (the host
 * stores and normalizes it, and the model sees it), any other file by the
 * receipt of an upload to the same session (shown as a file card). The text
 * part still names every saved file, so a host without these services, or a
 * file that cannot be attached, loses nothing but the preview.
 * @module im-robot/attach
 */
import type { InboundFile } from './channels/adapter.ts';
import type { AttachmentsLike, FileUploadsLike, PromptPart } from './types.ts';
/**
 * Largest file attached by upload. The host keeps every upload for good, so a
 * larger one (a long video) is only named in the text, where the binding's own
 * folder keeps it.
 */
export declare const MAX_ATTACHED_FILE_BYTES: number;
/** What attaching needs from the host; each service is optional. */
export interface AttachDeps {
    readonly attachments?: AttachmentsLike;
    readonly fileUploads?: FileUploadsLike;
    warn(message: string): void;
}
/**
 * The name a file card shows: the saved name without the time stamp the
 * adapter put in front.
 * @param path - the saved file.
 * @returns e.g. `报告.pdf` for `…/20261105-213502-报告.pdf`.
 */
export declare function displayName(path: string): string;
/**
 * Build the attachment parts for one message's files, in their order. Never
 * throws: a file that cannot be attached is logged and left out.
 * @param files - the saved files.
 * @param sessionId - the session the prompt goes to (uploads belong to it).
 * @param deps - the host services and a logger.
 * @param signal - cancels uploads.
 * @returns the parts to put after the text part.
 */
export declare function attachmentParts(files: readonly InboundFile[], sessionId: string, deps: AttachDeps, signal: AbortSignal): Promise<PromptPart[]>;
