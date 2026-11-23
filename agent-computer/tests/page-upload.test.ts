import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import {
  MAX_PAGE_UPLOAD_FILES,
  PageUploadError,
  pageUploadPaths,
  uploadToField,
} from "../src/page-upload";
import {
  createWorkspace,
  DEFAULT_WORKSPACE_LIMITS,
  WorkspaceFileError,
  WorkspaceFileTooLargeError,
  WorkspacePathError,
} from "../src/workspace";

/**
 * The browser half runs against a real Chromium:
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/page-upload.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const ACTING = { timeout: 2_000 };

let base: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "openbot-page-upload-"));
  root = join(base, "workspace");
  await mkdir(join(root, "EmployeeMaterials"), { recursive: true });
  await writeFile(join(root, "EmployeeMaterials", "体检报告.pdf"), "report");
  await writeFile(join(root, "second.pdf"), "second");
  await writeFile(join(base, "outside.txt"), "outside");
  await symlink(join(base, "outside.txt"), join(root, "escape.txt"));
  await symlink(join(root, "second.pdf"), join(root, "inside-link.pdf"));
  if (!asked) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
  await rm(base, { recursive: true, force: true });
});

describe("which workspace files may be uploaded", () => {
  const files = () => createWorkspace(root);

  test("a file in the workspace, with its name and size", async () => {
    const [file] = await files().uploadable(["EmployeeMaterials/体检报告.pdf"]);
    expect(file?.name).toBe("体检报告.pdf");
    expect(file?.bytes).toBe(6);
    expect(file?.mimeType).toBe("application/pdf");
    expect(file?.buffer.toString()).toBe("report");
  });

  test.each([
    "/etc/passwd",
    "../outside.txt",
    "EmployeeMaterials/../../outside.txt",
    "escape.txt",
    "inside-link.pdf",
    "./second.pdf",
    "EmployeeMaterials//体检报告.pdf",
    " second.pdf",
  ])("refuses %s", async (path) => {
    await expect(files().uploadable([path])).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  test("refuses a folder", async () => {
    await expect(
      files().uploadable(["EmployeeMaterials"]),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
  });

  test("refuses more bytes in total than a download may carry", async () => {
    const small = createWorkspace(root, {
      ...DEFAULT_WORKSPACE_LIMITS,
      downloadBytes: 10,
    });
    await expect(
      small.uploadable(["EmployeeMaterials/体检报告.pdf", "second.pdf"]),
    ).rejects.toBeInstanceOf(WorkspaceFileTooLargeError);
  });

  test("the list of paths is bounded and has no repeats", () => {
    expect(pageUploadPaths(["a", "a", "b"])).toEqual(["a", "b"]);
    for (const bad of [
      undefined,
      [],
      [1],
      Array.from({ length: MAX_PAGE_UPLOAD_FILES + 1 }, (_, i) => `f${i}`),
    ])
      expect(() => pageUploadPaths(bad)).toThrow(PageUploadError);
  });
});

describe.skipIf(!asked)("putting files into a page", () => {
  const PAGE = `<!doctype html><title>Upload</title>
  <input id="plain" type="file" aria-label="Plain">
  <div class="uploader"><button type="button" id="styled">Upload report</button>
    <input id="hidden" type="file" multiple style="display:none"></div>
  <section><button id="two">Two</button>
    <span><input type="file" style="display:none"><input type="file" style="display:none"></span></section>
  <p><button id="alone">Nothing here</button></p>
  <output id="log"></output>
  <script>
    document.addEventListener("change", (event) => {
      document.getElementById("log").textContent +=
        event.target.id + ":" + [...event.target.files].map((f) => f.name + "/" + f.size).join(",") + ";";
    });
  </script>`;

  async function open(): Promise<Page> {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    return page;
  }
  const payload = (name: string, text: string) => ({
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(text),
  });
  const report = () => payload("体检报告.pdf", "report");
  const second = () => payload("second.pdf", "second");

  test("into a visible input, firing change, with no file dialog", async () => {
    const page = await open();
    let dialogs = 0;
    page.on("filechooser", () => {
      dialogs += 1;
    });
    await uploadToField(page.locator("#plain"), [report()], ACTING);
    expect(await page.locator("#log").textContent()).toBe(
      "plain:体检报告.pdf/6;",
    );
    expect(dialogs).toBe(0);
    await page.close();
  });

  test("through the visible button, into the hidden input beside it, without clicking", async () => {
    const page = await open();
    await page.evaluate(() => {
      document.getElementById("styled")?.addEventListener("click", () => {
        document.title = "clicked";
      });
    });
    await uploadToField(page.locator("#styled"), [report(), second()], ACTING);
    expect(await page.locator("#log").textContent()).toBe(
      "hidden:体检报告.pdf/6,second.pdf/6;",
    );
    expect(await page.title()).toBe("Upload");
    await page.close();
  });

  test("refuses to guess between two inputs", async () => {
    const page = await open();
    await expect(
      uploadToField(page.locator("#two"), [report()], ACTING),
    ).rejects.toBeInstanceOf(PageUploadError);
    expect(await page.locator("#log").textContent()).toBe("");
    await page.close();
  }, 20_000);

  test("refuses a control with no file input near it", async () => {
    const page = await open();
    await page.evaluate(() => {
      for (const input of document.querySelectorAll('input[type="file"]'))
        input.remove();
    });
    await expect(
      uploadToField(page.locator("#alone"), [report()], ACTING),
    ).rejects.toBeInstanceOf(PageUploadError);
    await page.close();
  }, 20_000);

  test("refuses several files for a single-file input", async () => {
    const page = await open();
    await expect(
      uploadToField(page.locator("#plain"), [report(), second()], ACTING),
    ).rejects.toBeInstanceOf(PageUploadError);
    expect(await page.locator("#log").textContent()).toBe("");
    await page.close();
  }, 20_000);
});
