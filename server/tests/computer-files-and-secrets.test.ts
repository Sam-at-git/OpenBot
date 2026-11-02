import { describe, expect, test } from "bun:test";
import {
  classifyAttachment,
  computerUploadPath,
  DOCX_MIME,
  XLSX_MIME,
} from "@openbot/shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";
import {
  noComputerNote,
  resolveAttachmentParts,
  savedOnComputerNote,
} from "../src/channels/attachment-parts";
import { secretNameProblem } from "../src/computer/secrets";

const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1");

/** The start of a zip archive holding one named part: all the server looks at. */
const zipWith = (part: string) =>
  new Uint8Array(
    Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]),
      Buffer.from(`${"\0".repeat(22)}${part}<?xml version="1.0"?>`, "latin1"),
    ]),
  );

describe("an Excel or Word attachment", () => {
  test("is recognised by the part only it has, whatever the browser claimed", () => {
    expect(sniffMimeType(zipWith("xl/workbook.xml"), "")).toBe(XLSX_MIME);
    expect(
      sniffMimeType(zipWith("word/document.xml"), "application/octet-stream"),
    ).toBe(DOCX_MIME);
    expect(classifyAttachment(XLSX_MIME)).toBe("file");
    expect(classifyAttachment(DOCX_MIME)).toBe("file");
  });

  test("is refused when only the claim says so", () => {
    expect(
      classifyAttachment(
        sniffMimeType(zipWith("ppt/presentation.xml"), XLSX_MIME),
      ),
    ).not.toBe("file");
    expect(
      classifyAttachment(
        sniffMimeType(new Uint8Array([1, 2, 3, 0xff]), DOCX_MIME),
      ),
    ).not.toBe("file");
  });

  test("tells the Bot which Python library opens it", () => {
    const note = savedOnComputerNote(
      { mimeType: XLSX_MIME, name: "报价.xlsx", bytes: Buffer.from("x") },
      computerUploadPath("报价.xlsx"),
    );
    expect(note).toContain("~/uploads/报价.xlsx");
    expect(note).toContain("openpyxl");
  });
});

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
    expect(computerUploadPath("../../etc/passwd")).toBe(
      "uploads/_.._etc_passwd",
    );
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
