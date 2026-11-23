import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountBuiltApp } from "../src/built-app";

let root: string;
const app = new Hono();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-built-app-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<html>app</html>");
  await writeFile(join(root, "assets", "chunk-new.js"), "export {};");
  mountBuiltApp(app, root);
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("the built app", () => {
  test("a chunk from an earlier build is a 404, not the app's HTML", async () => {
    const response = await app.request("/assets/chunk-old.js");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("<html>");
  });

  test("a chunk of this build is served", async () => {
    const response = await app.request("/assets/chunk-new.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  test.each(["/index.html", "/channel/some-channel"])(
    "%s is the page, and the browser must check it before reuse",
    async (path) => {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<html>");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    },
  );

  test("an unmatched API call stays a 404", async () => {
    expect((await app.request("/api/nothing")).status).toBe(404);
  });
});
