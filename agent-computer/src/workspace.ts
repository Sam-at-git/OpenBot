/**
 * The Bot's files, and the boundary they must not escape.
 *
 * The computer has a `/workspace` volume so that anything a Bot should still have next week
 * survives the container. A Bot can read and write in it, which turns a durable directory into an
 * attack surface: the process runs as root inside its container, so `write_file("../../etc/passwd")`
 * is the obvious first thing to try and `read_file("../../root/.ssh/id_rsa")` the second.
 *
 * Path confinement is enforced in three layers:
 *
 *  1. Absolute paths are refused outright. A Bot names a file relative to its own workspace; there is
 *     no legitimate request that begins with `/`.
 *  2. The resolved path must be inside the root lexically. This catches `..` traversal.
 *  3. The resolved path must still be inside the root after symlinks are followed. This is the layer
 *     people miss: a symlink placed inside the workspace (by an earlier write, or by a page the Bot
 *     downloaded something from) passes the lexical check and then points anywhere on the filesystem.
 *     For a write, the file may not exist yet, so the deepest existing ancestor gets resolved, which
 *     is the directory the write will land in, AND the name itself is resolved when something is
 *     already there, because `writeFile` follows a link at the last component too.
 *
 * A factory taking its root as an argument rather than reading the environment, so the confinement
 * can be tested against a temporary directory instead of being taken on trust.
 */
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { type ZipEntry, zipStored } from "./zip";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export class WorkspaceFileNotFoundError extends WorkspaceFileError {}

export class WorkspaceFileTooLargeError extends WorkspaceFileError {}

export type WorkspaceLimits = {
  /**
   * Most bytes a read hands back.
   *
   * Bounded for the same reason page text is: the contents go into a model's context, and one large
   * file would push the rest of the conversation out of it.
   */
  readBytes: number;
  /** Most bytes a single write accepts, so a loop cannot fill the volume. */
  writeBytes: number;
  /** Most entries a listing describes, so a Bot cannot paste a whole disk into its own context. */
  listEntries: number;
  /** Most bytes one download may stream, so a large artifact cannot exhaust the connection. */
  downloadBytes: number;
  /** Most files and folders one folder download may pack. A folder's bytes are bounded by `downloadBytes`. */
  folderEntries?: number;
};

/**
 * One thing in the workspace. Folders included so a Bot can see the shape, not just the leaves.
 *
 * Mirrors `WorkspaceEntry` in the server's published contract (`server/src/computer/schema.ts`), the
 * same way `SnapshotElement` does. Duplicated rather than shared because this process is a separate
 * deployable with no code in common with the server; the two must be changed together, and a field
 * added here and not there is invisible until a Bot asks for it.
 */
export type WorkspaceEntry = {
  /** Relative to the workspace root, which is the only form a request may use. */
  path: string;
  kind: "file" | "folder";
  bytes?: number;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  readBytes: 64_000,
  writeBytes: 1_000_000,
  listEntries: 500,
  downloadBytes: 100 * 1024 * 1024,
  folderEntries: 10_000,
};

export function createWorkspace(
  rootPath: string,
  limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS,
) {
  /**
   * Turn a Bot's requested path into a real one inside the workspace, or refuse.
   *
   * `forWrite` changes only which part of the path must already exist: a read resolves the file
   * itself, a write resolves the directory it would be created in.
   */
  async function resolvePath(
    requested: string,
    forWrite: boolean,
  ): Promise<string> {
    if (typeof requested !== "string" || !requested.trim()) {
      throw new WorkspacePathError("A file path is required.");
    }
    const wanted = requested.trim();

    if (isAbsolute(wanted)) {
      throw new WorkspacePathError(
        "Use a path relative to your workspace, not an absolute one.",
      );
    }
    // Refused explicitly rather than left to the containment check, so the Bot is told what it did
    // wrong and can correct it, instead of receiving a generic denial it may retry verbatim.
    if (wanted.split(/[\\/]/).includes("..")) {
      throw new WorkspacePathError(
        "A file path may not contain '..'. You can only reach files inside your own workspace.",
      );
    }

    const root = await realpath(rootPath);
    const target = resolve(root, wanted);
    assertInside(root, target);

    // Layer three. Resolve what exists on disk and check again, because everything above
    // reasons about the path as text and a symlink makes the text a lie.
    const anchor = forWrite ? dirname(target) : target;
    let realAnchor: string;
    try {
      realAnchor = await realpath(anchor);
    } catch {
      if (!forWrite) {
        throw new WorkspaceFileNotFoundError(`There is no file at ${wanted}.`);
      }
      // The parent directory does not exist yet. Walk up to the nearest one that does and verify it,
      // so a write into a new subdirectory is allowed but cannot be aimed through a symlink.
      realAnchor = await nearestExistingAncestor(root, anchor);
    }
    assertInside(root, realAnchor, wanted);

    if (!forWrite) return realAnchor;

    /*
     * Layer three again, for the last component rather than the directory holding it.
     *
     * Containing `dirname(target)` proves where a NEW file would be created. It proves nothing about
     * a name that already exists, and `writeFile` follows a symlink at the last component the same
     * way `readFile` does. A link at `notes.txt` pointing at `/root/.ssh/authorized_keys` passes
     * every check above, having no `..`, not being absolute, and sitting directly in the workspace,
     * and the bytes land outside the volume. The read side already refuses the identical link; the
     * write side was the asymmetry.
     *
     * The link has to get there first, which takes a shell or an archive that was unpacked with one,
     * so this is not a fresh escape for a Bot that already has `run_command`: that Bot can write
     * outside directly. What it is, is a hole in what the gateway can still see. The decision and the
     * audit row are both made against the path as the Bot asked for it, so a rule written for
     * `credentials/` or `*.env` is evaluated against `notes.txt` and never sees the file that gets
     * written, and the row names a file in the workspace that nothing touched. A deployment that
     * denies `run_command` and allows writes is relying on exactly that, and so is one reading the
     * trail afterwards. A permissive workspace is a decision a deployment can make. A trail that
     * describes a different file from the one on disk is not.
     */
    const landing = await writeDestination(target, wanted);
    if (landing === target) return target;

    // A link was followed, so the destination gets the checks the requested path already passed:
    // inside lexically, and inside after the directory holding it is resolved.
    /*
     * The holder is resolved BEFORE either check. `root` is a real path, so comparing it against a
     * destination that still runs through a symlinked ancestor refuses a link that points straight
     * back inside, which is what happens wherever the workspace sits behind one.
     */
    const holder = await realpath(dirname(landing)).catch(() => null);
    if (holder === null) {
      throw new WorkspacePathError(
        `${wanted} points at somewhere that does not exist, so where a write would land cannot be established.`,
      );
    }
    assertInside(root, holder, wanted);
    const resolved = join(holder, basename(landing));
    assertInside(root, resolved, wanted);
    return resolved;
  }

  return {
    resolvePath,

    /**
     * What is in the workspace.
     *
     * Recursive, because a Bot that saved `reports/august/summary.csv` needs to find it again, and a
     * listing that stops at the first level would show a `reports` directory and no way in. Bounded by
     * entry count for the same reason everything else here is bounded.
     */
    async list(
      requested = ".",
      /**
       * One folder at a time, for a person browsing the files. A Bot's listing stays recursive; a
       * person opens folders one by one, and a whole-tree walk would stop at `listEntries` before it
       * reached the folder they opened.
       */
      options: { recursive?: boolean } = {},
    ): Promise<{
      path: string;
      entries: WorkspaceEntry[];
      truncated: boolean;
    }> {
      const root = await realpath(rootPath);
      // "." and "" both mean the workspace itself, which `resolvePath` would reject as a bare relative
      // path with nothing in it. Anything else goes through the same confinement as a read.
      const start =
        requested === "." || requested.trim() === ""
          ? root
          : await resolvePath(requested, false);

      const info = await stat(start).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no folder at ${requested}.`);
      }
      if (!info.isDirectory()) {
        throw new WorkspaceFileError(`${requested} is a file, not a folder.`);
      }

      const entries: WorkspaceEntry[] = [];
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated) return;
        const found = await readdir(dir, { withFileTypes: true });
        for (const item of found) {
          if (entries.length >= limits.listEntries) {
            truncated = true;
            return;
          }
          const full = `${dir}/${item.name}`;
          // Relative to the workspace root, because that is the only form a Bot may name in a request.
          const shown = full.slice(root.length + 1);
          if (item.isDirectory()) {
            entries.push({ path: shown, kind: "folder" });
            if (options.recursive !== false) await walk(full);
            continue;
          }
          if (!item.isFile()) continue;
          const size = await stat(full).catch(() => null);
          entries.push({
            path: shown,
            kind: "file",
            ...(size ? { bytes: size.size } : {}),
          });
        }
      };

      await walk(start);
      return { path: requested, entries, truncated };
    },

    /** Read a text file. Bounded, and it says when it gave you less than the whole thing. */
    async read(requested: string): Promise<{
      path: string;
      text: string;
      truncated: boolean;
      bytes: number;
    }> {
      const full = await resolvePath(requested, false);
      const info = await stat(full).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no file at ${requested}.`);
      }
      if (info.isDirectory()) {
        throw new WorkspaceFileError(
          `${requested} is a directory, not a file.`,
        );
      }

      const buffer = await readFile(full);
      const slice = buffer.subarray(0, limits.readBytes);
      return {
        path: requested,
        // Decoded as UTF-8. A binary file therefore comes back as replacement characters rather
        // than as a base64 blob nothing can read: this tool is for the notes, CSVs and JSON a Bot
        // actually works with, and pretending otherwise would invite it to try images.
        text: slice.toString("utf8"),
        truncated: buffer.byteLength > slice.byteLength,
        bytes: buffer.byteLength,
      };
    },

    /**
     * Open a file as raw bytes for a download.
     *
     * The same `resolvePath` used by text reads enforces the workspace boundary, including symlink
     * resolution. The file is streamed from disk rather than read into a string, so PDFs, images and
     * archives are returned byte-for-byte and the text read limit does not apply.
     */
    async download(requested: string): Promise<{
      path: string;
      name: string;
      bytes: number;
      body: Blob;
    }> {
      const full = await resolvePath(requested, false);
      const info = await stat(full).catch(() => null);
      if (!info) {
        throw new WorkspaceFileNotFoundError(
          `There is no file at ${requested}.`,
        );
      }
      if (!info.isFile()) {
        throw new WorkspaceFileError(`${requested} is not a file.`);
      }
      if (info.size > limits.downloadBytes) {
        throw new WorkspaceFileTooLargeError(
          `That file is ${info.size} bytes and the download limit is ${limits.downloadBytes}.`,
        );
      }

      return {
        path: requested,
        name: basename(requested.replace(/\\/g, "/")) || "download",
        bytes: info.size,
        // Bun serves this file without reading it into memory, and preserves the byte length a
        // ReadableStream response loses. The caller still receives the raw bytes unchanged.
        body: Bun.file(full),
      };
    },

    /**
     * A folder and everything in it, as one stored .zip, for a person downloading it from the Files page.
     *
     * The folder itself goes through `resolvePath` like any read. Inside it, a symlink is skipped rather
     * than followed, the same as the listing, so a link to somewhere outside the workspace cannot carry
     * that place into the archive. The whole folder is bounded by `downloadBytes`, checked before
     * anything is read, and by `folderEntries`.
     */
    async downloadFolder(requested: string): Promise<{
      path: string;
      name: string;
      bytes: number;
      body: Blob;
    }> {
      const root = await realpath(rootPath);
      const atRoot = requested === "." || requested.trim() === "";
      const start = atRoot ? root : await resolvePath(requested, false);
      const info = await stat(start).catch(() => null);
      if (!info) {
        throw new WorkspaceFileNotFoundError(
          `There is no folder at ${requested}.`,
        );
      }
      if (!info.isDirectory()) {
        throw new WorkspaceFileError(`${requested} is a file, not a folder.`);
      }

      const top = atRoot
        ? "workspace"
        : basename(requested.replace(/\\/g, "/").replace(/\/+$/, "")) ||
          "folder";
      const maxEntries = limits.folderEntries ?? 10_000;
      const found: { name: string; full?: string; modified: Date }[] = [
        { name: `${top}/`, modified: info.mtime },
      ];
      let total = 0;

      const walk = async (dir: string, inside: string): Promise<void> => {
        const items = await readdir(dir, { withFileTypes: true });
        items.sort((a, b) => a.name.localeCompare(b.name));
        for (const item of items) {
          if (!item.isDirectory() && !item.isFile()) continue;
          if (found.length >= maxEntries) {
            throw new WorkspaceFileTooLargeError(
              `${requested || "The workspace"} has more than ${maxEntries} files and folders, which is more than one download may pack.`,
            );
          }
          const full = `${dir}/${item.name}`;
          const name = `${inside}${item.name}`;
          const itemInfo = await stat(full);
          if (item.isDirectory()) {
            found.push({ name: `${name}/`, modified: itemInfo.mtime });
            await walk(full, `${name}/`);
            continue;
          }
          total += itemInfo.size;
          if (total > limits.downloadBytes) {
            throw new WorkspaceFileTooLargeError(
              `${requested || "The workspace"} holds more than ${limits.downloadBytes} bytes, which is the download limit.`,
            );
          }
          found.push({ name, full, modified: itemInfo.mtime });
        }
      };
      await walk(start, `${top}/`);

      const entries: ZipEntry[] = [];
      for (const entry of found) {
        entries.push({
          name: entry.name,
          modified: entry.modified,
          ...(entry.full
            ? { data: new Uint8Array(await readFile(entry.full)) }
            : {}),
        });
      }
      const archive = zipStored(entries);
      return {
        path: requested,
        name: `${top}.zip`,
        bytes: archive.byteLength,
        body: new Blob([archive]),
      };
    },

    /** Write a text file, creating parent directories inside the workspace as needed. */
    async write(
      requested: string,
      contents: string,
      options: { append?: boolean } = {},
    ): Promise<{ path: string; bytes: number; appended: boolean }> {
      if (typeof contents !== "string") {
        throw new WorkspaceFileError("The contents to write must be text.");
      }
      const bytes = Buffer.byteLength(contents, "utf8");
      if (bytes > limits.writeBytes) {
        throw new WorkspaceFileError(
          `That is ${bytes} bytes and the limit is ${limits.writeBytes}.`,
        );
      }

      const full = await resolvePath(requested, true);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, {
        encoding: "utf8",
        flag: options.append ? "a" : "w",
      });
      return { path: requested, bytes, appended: options.append === true };
    },

    /**
     * Write a file's raw bytes: a PDF or a spreadsheet a person attached in a conversation, put where a
     * skill's script can open it. Its own limit, `uploadBytes`, since these are documents and not text a
     * Bot wrote.
     */
    async upload(
      requested: string,
      contents: Uint8Array,
    ): Promise<{ path: string; bytes: number }> {
      if (contents.byteLength > UPLOAD_BYTES) {
        throw new WorkspaceFileTooLargeError(
          `That is ${contents.byteLength} bytes and the limit is ${UPLOAD_BYTES}.`,
        );
      }
      const full = await resolvePath(requested, true);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
      return { path: requested, bytes: contents.byteLength };
    },

    /** A new folder, and any folders above it that are missing. An existing folder is left as it is. */
    async makeFolder(requested: string): Promise<{ path: string }> {
      const full = await resolvePath(requested, true);
      const there = await lstat(full).catch(() => null);
      if (there && !there.isDirectory()) {
        throw new WorkspaceFileError(
          `${requested.trim()} is a file, not a folder.`,
        );
      }
      await mkdir(full, { recursive: true });
      return { path: requested.trim() };
    },

    /**
     * Delete a file, or a folder with everything in it.
     *
     * The name itself is removed, never what it points at: `resolvePath` for a read follows a link
     * to its target, so deleting through it would delete the file a link names rather than the link.
     * Here the folder holding the name is resolved and checked, and the name is removed from it with
     * `rm`, which does not follow a link at the last component. The workspace itself cannot be deleted.
     */
    async remove(requested: string): Promise<{ path: string }> {
      if (typeof requested !== "string" || !requested.trim()) {
        throw new WorkspacePathError("A file path is required.");
      }
      const wanted = requested.trim().replace(/[\\/]+$/, "");
      if (wanted === "" || wanted === ".") {
        throw new WorkspacePathError("The workspace itself can't be deleted.");
      }
      const normal = wanted.replace(/\\/g, "/");
      const name = basename(normal);
      if (name === "." || name === "..") {
        throw new WorkspacePathError(
          "A file path may not contain '..'. You can only reach files inside your own workspace.",
        );
      }
      const root = await realpath(rootPath);
      // The folder holding the name gets the same refusals as any read: absolute, `..`, outside
      // after links. An absolute path never has "." as its folder, so it is refused there.
      const folder = dirname(normal);
      const holder = folder === "." ? root : await resolvePath(folder, false);
      if (!(await stat(holder)).isDirectory()) {
        throw new WorkspaceFileNotFoundError(`There is nothing at ${wanted}.`);
      }
      const target = join(holder, name);
      assertInside(root, target, wanted);
      if (target === root) {
        throw new WorkspacePathError("The workspace itself can't be deleted.");
      }
      const there = await lstat(target).catch(() => null);
      if (!there) {
        throw new WorkspaceFileNotFoundError(`There is nothing at ${wanted}.`);
      }
      await rm(target, { recursive: there.isDirectory(), force: false });
      return { path: wanted };
    },
  };
}

/** Most bytes one uploaded file may have (an attached document; see `upload`). */
export const UPLOAD_BYTES = 32 * 1024 * 1024;

export type Workspace = ReturnType<typeof createWorkspace>;

/** Containment, as a path comparison that cannot be fooled by a shared prefix. */
function assertInside(root: string, candidate: string, shown?: string): void {
  const rel = relative(root, candidate);
  // `relative` returns "" for the root itself, which is inside. It returns something starting with
  // ".." for anything outside, and an absolute path when the two are on different roots. Comparing
  // with startsWith on the raw strings instead would let "/workspace-evil" pass as "/workspace".
  const outside =
    rel !== "" &&
    (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  if (outside) {
    throw new WorkspacePathError(
      `${shown ?? candidate} is outside your workspace, so it cannot be reached.`,
    );
  }
}

/**
 * How many links a chain may pass through before it is treated as a cycle rather than a path.
 *
 * Linux gives up at 40. Anything approaching this is a loop or a deliberate attempt to make the walk
 * expensive, and neither is a file a Bot needs to write.
 */
const MAX_LINK_HOPS = 32;

/**
 * Where a write to `target` would actually put the bytes.
 *
 * Returns `target` unchanged when nothing is there or what is there is not a link, which is every
 * ordinary write. Only a name that is already a symlink walks.
 *
 * Walked with `lstat` and `readlink` rather than resolved with `realpath`, because `realpath` throws
 * on a DANGLING link and `writeFile` creates the file at its destination regardless. A link aimed at
 * a name that does not exist yet would otherwise escape through the failure path rather than the
 * success one, which is the harder version of the bug to notice.
 *
 * Confining rather than forbidding, the same as the read side. A link that points back inside the
 * workspace keeps working: refusing every link would be easier and would break legitimate use.
 */
async function writeDestination(
  target: string,
  shown: string,
): Promise<string> {
  let current = target;
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
    const entry = await lstat(current).catch(() => null);
    // Nothing there, or something that is not a link. This is where the write lands.
    if (entry === null || !entry.isSymbolicLink()) return current;
    // A relative link is relative to the directory the link sits in, not to the workspace root.
    current = resolve(dirname(current), await readlink(current));
  }
  throw new WorkspacePathError(
    `${shown} is a chain of links that does not settle, so where a write would land cannot be established.`,
  );
}

/** The closest ancestor of `target` that exists, never above `root`. */
async function nearestExistingAncestor(
  root: string,
  target: string,
): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Ran out of path without finding anything. Only reachable if the root itself vanished.
        throw new WorkspacePathError("The workspace directory is missing.");
      }
      assertInside(root, parent);
      current = parent;
    }
  }
}
