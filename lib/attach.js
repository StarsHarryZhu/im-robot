/**
 * Turn the files a chat message brought into prompt parts the host's
 * conversation view shows: an image goes into the prompt itself (the host
 * stores and normalizes it, and the model sees it), any other file by the
 * receipt of an upload to the same session (shown as a file card). The text
 * part still names every saved file, so a host without these services, or a
 * file that cannot be attached, loses nothing but the preview.
 * @module im-robot/attach
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
/**
 * Largest file attached by upload. The host keeps every upload for good, so a
 * larger one (a long video) is only named in the text, where the binding's own
 * folder keeps it.
 */
export const MAX_ATTACHED_FILE_BYTES = 20 * 1024 * 1024;
/** Image types by the extension a saved image carries. */
const IMAGE_TYPES = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};
/**
 * The name a file card shows: the saved name without the time stamp the
 * adapter put in front.
 * @param path - the saved file.
 * @returns e.g. `报告.pdf` for `…/20261105-213502-报告.pdf`.
 */
export function displayName(path) {
    const name = basename(path);
    const shown = name.replace(/^\d{8}-\d{6}-/u, '');
    return shown === '' ? name : shown;
}
/**
 * Build the attachment parts for one message's files, in their order. Never
 * throws: a file that cannot be attached is logged and left out.
 * @param files - the saved files.
 * @param sessionId - the session the prompt goes to (uploads belong to it).
 * @param deps - the host services and a logger.
 * @param signal - cancels uploads.
 * @returns the parts to put after the text part.
 */
export async function attachmentParts(files, sessionId, deps, signal) {
    const parts = [];
    const limits = deps.attachments?.imageLimits;
    let images = 0;
    let imageBytes = 0;
    for (const file of files) {
        if (signal.aborted)
            return parts;
        const name = displayName(file.path);
        try {
            if (file.kind === 'image') {
                const mediaType = IMAGE_TYPES[extname(file.path).toLowerCase()];
                if (limits === undefined || mediaType === undefined || !limits.mediaTypes.includes(mediaType))
                    continue;
                if (file.bytes > limits.maxImageBytes || images + 1 > limits.maxImagesPerMessage || imageBytes + file.bytes > limits.maxMessageImageBytes)
                    continue;
                const data = await readFile(file.path);
                images += 1;
                imageBytes += data.length;
                parts.push({ type: 'image', data: data.toString('base64'), mediaType, name });
                continue;
            }
            if (deps.fileUploads === undefined || file.bytes > MAX_ATTACHED_FILE_BYTES)
                continue;
            const { receiptId } = await deps.fileUploads.uploadStream({
                sessionId,
                data: createReadStream(file.path),
                name,
                signal,
            });
            parts.push({ type: 'file', receiptId });
        }
        catch (error) {
            deps.warn(`im-robot: could not attach ${file.kind} ${name}: ${String(error)}`);
        }
    }
    return parts;
}
