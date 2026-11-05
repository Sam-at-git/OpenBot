import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspaceFileNotFoundError,
  WorkspaceFileTooLargeError,
  WorkspacePathError,
} from "../src/workspace";
import { crc32 } from "../src/zip";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "openbot-workspace-folder-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "a private key", "utf8");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

/** Reads a stored zip back through its central directory: name → bytes. */
async function unzip(body: Blob): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await body.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 8, true) & 0x0800).toBe(0x0800);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLength),
    );
    const localName = view.getUint16(local + 26, true);
    const data = bytes.subarray(
      local + 30 + localName,
      local + 30 + localName + size,
    );
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

const text = (data: Uint8Array | undefined) =>
  data ? new TextDecoder().decode(data) : undefined;

describe("downloading a folder from the workspace", () => {
  test("packs every file and sub-folder under the folder's own name", async () => {
    await mkdir(join(root, "2026", "pp_zd"), { recursive: true });
    await writeFile(join(root, "2026", "合同.txt"), "甲方 乙方");
    await writeFile(
      join(root, "2026", "pp_zd", "page.bin"),
      Buffer.from([0, 1, 255]),
    );
    await mkdir(join(root, "2026", "empty"));

    const download = await createWorkspace(root).downloadFolder("2026");

    expect(download.name).toBe("2026.zip");
    expect(download.bytes).toBe(download.body.size);
    const files = await unzip(download.body);
    expect([...files.keys()].sort()).toEqual([
      "2026/",
      "2026/empty/",
      "2026/pp_zd/",
      "2026/pp_zd/page.bin",
      "2026/合同.txt",
    ]);
    expect(text(files.get("2026/合同.txt"))).toBe("甲方 乙方");
    expect([...(files.get("2026/pp_zd/page.bin") ?? [])]).toEqual([0, 1, 255]);
  });

  test("the whole workspace when no folder is named", async () => {
    await writeFile(join(root, "notes.md"), "hi");
    const download = await createWorkspace(root).downloadFolder("");
    expect(download.name).toBe("workspace.zip");
    expect(text((await unzip(download.body)).get("workspace/notes.md"))).toBe(
      "hi",
    );
  });

  test("skips a symlink rather than packing what it points at", async () => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "kept.txt"), "kept");
    await symlink(join(outside, "secret.txt"), join(root, "docs", "leak.txt"));
    await symlink(outside, join(root, "docs", "leak-dir"));

    const files = await unzip(
      (await createWorkspace(root).downloadFolder("docs")).body,
    );
    expect([...files.keys()].sort()).toEqual(["docs/", "docs/kept.txt"]);
  });

  test("refuses a path outside the workspace", async () => {
    await expect(
      createWorkspace(root).downloadFolder("../outside"),
    ).rejects.toThrow(WorkspacePathError);
  });

  test("refuses a file, and a folder that is not there", async () => {
    await writeFile(join(root, "a.txt"), "a");
    const ws = createWorkspace(root);
    await expect(ws.downloadFolder("a.txt")).rejects.toThrow(
      WorkspaceFileError,
    );
    await expect(ws.downloadFolder("missing")).rejects.toThrow(
      WorkspaceFileNotFoundError,
    );
  });

  test("refuses a folder above the download limit or the entry limit", async () => {
    await mkdir(join(root, "big"));
    await writeFile(join(root, "big", "a.bin"), "12345");
    await writeFile(join(root, "big", "b.bin"), "67890");
    const limits = { readBytes: 64_000, writeBytes: 1_000, listEntries: 500 };
    await expect(
      createWorkspace(root, { ...limits, downloadBytes: 8 }).downloadFolder(
        "big",
      ),
    ).rejects.toThrow(WorkspaceFileTooLargeError);
    await expect(
      createWorkspace(root, {
        ...limits,
        downloadBytes: 1_000,
        folderEntries: 2,
      }).downloadFolder("big"),
    ).rejects.toThrow(WorkspaceFileTooLargeError);
  });
});
