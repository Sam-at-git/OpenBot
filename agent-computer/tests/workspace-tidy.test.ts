import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspaceFileNotFoundError,
  WorkspacePathError,
} from "../src/workspace";

/**
 * A person tidying a Bot's files from its Files page: one folder at a time, a new folder, a delete.
 * Against a real filesystem, for the reason `workspace.test.ts` gives: a link only means anything on
 * real inodes.
 */

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "openbot-tidy-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(join(root, "reports", "august"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "notes", "utf8");
  await writeFile(join(root, "reports", "summary.csv"), "a,b", "utf8");
  await writeFile(join(root, "reports", "august", "deep.csv"), "c", "utf8");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "a private key", "utf8");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe("listing one folder at a time", () => {
  test("a person's listing stops at the folder it was asked for", async () => {
    const listing = await createWorkspace(root).list("reports", {
      recursive: false,
    });
    expect(listing.entries.map((entry) => entry.path).sort()).toEqual([
      "reports/august",
      "reports/summary.csv",
    ]);
  });

  test("a Bot's listing still walks the whole tree", async () => {
    const listing = await createWorkspace(root).list();
    expect(listing.entries.map((entry) => entry.path)).toContain(
      "reports/august/deep.csv",
    );
  });
});

describe("making a folder", () => {
  test("makes it and any folders above it", async () => {
    await createWorkspace(root).makeFolder("ims-manual/2026");
    expect((await lstat(join(root, "ims-manual", "2026"))).isDirectory()).toBe(
      true,
    );
  });

  test("an existing folder is left alone, a file of that name is refused", async () => {
    const workspace = createWorkspace(root);
    await workspace.makeFolder("reports");
    expect(await readFile(join(root, "reports", "summary.csv"), "utf8")).toBe(
      "a,b",
    );
    await expect(workspace.makeFolder("notes.txt")).rejects.toBeInstanceOf(
      WorkspaceFileError,
    );
  });

  test("cannot be made outside the workspace", async () => {
    const workspace = createWorkspace(root);
    await expect(workspace.makeFolder("../escaped")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(workspace.makeFolder("/tmp/escaped")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await symlink(outside, join(root, "door"));
    await expect(workspace.makeFolder("door/inside")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    expect(await exists(join(outside, "inside"))).toBe(false);
  });
});

describe("deleting", () => {
  test("deletes a file", async () => {
    await createWorkspace(root).remove("notes.txt");
    expect(await exists(join(root, "notes.txt"))).toBe(false);
  });

  test("deletes a folder with everything in it", async () => {
    await createWorkspace(root).remove("reports/");
    expect(await exists(join(root, "reports"))).toBe(false);
  });

  test("a link is removed, and what it points at is kept", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await symlink(outside, join(root, "link-folder"));
    const workspace = createWorkspace(root);
    await workspace.remove("link.txt");
    await workspace.remove("link-folder");
    expect(await exists(join(root, "link.txt"))).toBe(false);
    expect(await exists(join(root, "link-folder"))).toBe(false);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
      "a private key",
    );
  });

  test("nothing outside the workspace can be deleted through it", async () => {
    const workspace = createWorkspace(root);
    await symlink(outside, join(root, "door"));
    for (const path of [
      "../outside/secret.txt",
      "/etc/hosts",
      "door/secret.txt",
      "..",
    ]) {
      await expect(workspace.remove(path)).rejects.toBeInstanceOf(
        WorkspacePathError,
      );
    }
    expect(await exists(join(outside, "secret.txt"))).toBe(true);
  });

  test("the workspace itself cannot be deleted", async () => {
    const workspace = createWorkspace(root);
    for (const path of [".", "./", ""]) {
      await expect(workspace.remove(path)).rejects.toBeInstanceOf(
        WorkspacePathError,
      );
    }
    expect(await exists(root)).toBe(true);
  });

  test("deleting what is not there says so", async () => {
    await expect(
      createWorkspace(root).remove("missing.txt"),
    ).rejects.toBeInstanceOf(WorkspaceFileNotFoundError);
  });
});
