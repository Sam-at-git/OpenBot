import { describe, expect, test } from "bun:test";
import {
  classifyAttachment,
  computerUploadPath,
} from "@openbot/shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";
import {
  noComputerNote,
  resolveAttachmentParts,
  savedOnComputerNote,
} from "../src/channels/attachment-parts";
import { secretNameProblem } from "../src/computer/secrets";

const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1");

describe("a PDF attachment", () => {
  test("is recognised by its bytes, not its claim", () => {
    expect(sniffMimeType(new Uint8Array(pdf), "application/octet-stream")).toBe(
      "application/pdf",
    );
    expect(classifyAttachment("application/pdf")).toBe("file");
    expect(
      classifyAttachment(
        sniffMimeType(new Uint8Array([1, 2, 3, 0xff]), "application/pdf"),
      ),
    ).not.toBe("file");
  });

  test("gets a safe path in the Bot's home folder", () => {
    expect(computerUploadPath("合同 2026.pdf")).toBe("uploads/合同 2026.pdf");
    expect(computerUploadPath("../../etc/passwd")).toBe("uploads/_.._etc_passwd");
    expect(computerUploadPath("a/b\\c.pdf")).toBe("uploads/a_b_c.pdf");
    expect(computerUploadPath("")).toBe("uploads/file");
  });

  test("reaches the model as a note saying where it is, never as bytes, and costs no inline budget", async () => {
    const part = {
      type: "document",
      source: { type: "url", value: "/api/attachments/a1" },
      metadata: { attachmentId: "a1", filename: "contract.pdf" },
    };
    const file = {
      mimeType: "application/pdf",
      name: "contract.pdf",
      bytes: pdf,
    };
    const budget = { remaining: 1, limit: 1 };
    const saved = (await resolveAttachmentParts(
      [part],
      async () => file,
      "fail",
      budget,
      (_id, f) => savedOnComputerNote(f, computerUploadPath(f.name)),
    )) as { type: string; text: string }[];
    expect(saved[0]?.type).toBe("text");
    expect(saved[0]?.text).toContain("~/uploads/contract.pdf");
    expect(budget.remaining).toBe(1);
    const without = (await resolveAttachmentParts(
      [part],
      async () => file,
    )) as {
      text: string;
    }[];
    expect(without[0]?.text).toBe(noComputerNote("a1", file));
  });
});

describe("computer secret names", () => {
  test("upper-case variable names are accepted and the computer's own are refused", () => {
    expect(secretNameProblem("LLAMA_CLOUD_API_KEY")).toBeUndefined();
    expect(secretNameProblem("lower")).toBeDefined();
    expect(secretNameProblem("PATH")).toContain("set by the computer");
    expect(secretNameProblem("HTTPS_PROXY")).toBeDefined();
    expect(secretNameProblem("1ABC")).toBeDefined();
  });
});
