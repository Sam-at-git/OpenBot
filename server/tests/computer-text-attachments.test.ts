import { describe, expect, test } from "bun:test";
import {
  COMPUTER_TEXT_BYTES,
  COMPUTER_TEXT_PREVIEW_CHARS,
  computerUploadPath,
} from "@openbot/shared/attachments";
import {
  type ComputerTextNote,
  resolveAttachmentParts,
  savedTextOnComputerNote,
} from "../src/channels/attachment-parts";

const part = {
  type: "document",
  source: { type: "url", value: "/api/attachments/m1" },
  metadata: { attachmentId: "m1", filename: "01-登录.md" },
};

const manual = (characters: number) => ({
  mimeType: "text/markdown",
  name: "01-登录.md",
  bytes: Buffer.from(
    Array.from({ length: Math.ceil(characters / 20) }, (_, line) =>
      `第${line}行：点击登录按钮。\n`.padEnd(20, "。"),
    )
      .join("")
      .slice(0, characters),
    "utf8",
  ),
});

/** The note the conversation uses: a long file on the computer is described, else put in. */
const onComputer =
  (saved: boolean): ComputerTextNote =>
  (_id, file) =>
    file.bytes.length > COMPUTER_TEXT_BYTES && saved
      ? savedTextOnComputerNote(file, computerUploadPath(file.name))
      : null;

const resolve = async (
  file: ReturnType<typeof manual>,
  note?: ComputerTextNote,
  budget = { remaining: 32 * 1024 * 1024, limit: 32 * 1024 * 1024 },
) =>
  (
    (await resolveAttachmentParts(
      [part],
      async () => file,
      "fail",
      budget,
      undefined,
      note,
    )) as { type: string; text: string }[]
  )[0];

describe("a long text attachment, for a Bot with a computer", () => {
  test("is shown by its beginning and where the whole of it is, and costs no inline budget", async () => {
    const file = manual(20_000);
    expect(file.bytes.length).toBeGreaterThan(COMPUTER_TEXT_BYTES);
    const budget = { remaining: 100, limit: 100 };
    const shown = await resolve(file, onComputer(true), budget);
    expect(shown?.type).toBe("text");
    expect(shown?.text).toContain("~/uploads/01-登录.md");
    expect(shown?.text).toContain("第0行");
    expect(shown?.text.length).toBeLessThan(COMPUTER_TEXT_PREVIEW_CHARS + 800);
    expect(budget.remaining).toBe(100);
  });

  test("is put in whole when it could not be saved", async () => {
    const file = manual(20_000);
    const shown = await resolve(file, onComputer(false));
    expect(shown?.text).not.toContain("~/uploads/");
    expect(shown?.text.length).toBeGreaterThan(19_000);
  });
});

describe("a short text attachment, or a Bot with no computer", () => {
  test("a short one is put in whole", async () => {
    const shown = await resolve(manual(2_000), onComputer(true));
    expect(shown?.text).not.toContain("~/uploads/");
    expect(shown?.text).toContain("第0行");
  });

  test("with no computer, a long one is put in whole as before", async () => {
    const shown = await resolve(manual(20_000));
    expect(shown?.text.length).toBeGreaterThan(19_000);
  });
});
