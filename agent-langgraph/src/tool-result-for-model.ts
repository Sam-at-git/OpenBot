/**
 * A tool result as the model reads it.
 *
 * Its own module for the reason `history.ts` is: `index.ts` calls `serve()` at module scope.
 *
 * Two things in a result cost a local model minutes and tell it nothing:
 *
 * - IMAGES WRITTEN AS TEXT. `computer_screenshot` answers with the PNG in base64, and a tool result is text, so a
 *   text model was handed 70 to 190 thousand characters of it. One screenshot took an IMS Tester step from 50k to
 *   96k input tokens (2026-11-15), and every later step paid for it again until the history budget dropped it.
 * - ONE RESULT LARGER THAN THE REST OF THE CONVERSATION. Command output is already cut at 64 KiB a stream on the
 *   computer, which is still tens of thousands of tokens on every step that follows.
 *
 * Applied before every model call, to the run's own results and to those replayed from earlier turns. What is stored
 * and shown is unchanged.
 */

/** The longest result the model is handed, in characters. A 14k-character test-case file still fits whole. */
export const TOOL_RESULT_MAX_CHARS = 16_000;

/** A run of base64 this long is binary data, never prose: no word, path or id is two thousand characters. */
const ENCODED_DATA = /(?:data:[\w.+-]+\/[\w.+-]+;base64,)?[A-Za-z0-9+/]{2000,}={0,2}/g;

export function toolResultForModel(
  content: string,
  maxChars = TOOL_RESULT_MAX_CHARS,
): string {
  const text = content.replace(
    ENCODED_DATA,
    (data) =>
      `[${data.length} characters of image or binary data left out. You read text only: use computer_snapshot or computer_read to see the page.]`,
  );
  if (text.length <= maxChars) return text;
  // Most of it from the start, where a result says what it is, and the end, where a command says how it finished.
  const head = Math.floor(maxChars * 0.75);
  const tail = maxChars - head;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n[${cut} characters cut from the middle of this result. Ask for less: filter with grep, head or a short script.]\n${text.slice(-tail)}`;
}
