import { describe, expect, test } from "bun:test";
import { entryPath, shouldReloadForNewBuild } from "../src/lib/stale-build";

const OLD = "/assets/index-old.js";
const page = (entry: string) =>
  `<script type="module" crossorigin src="${entry}"></script>`;

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const serves =
  (body: string, status = 200) =>
  async () =>
    new Response(body, { status });

describe("a chunk that failed to load", () => {
  test("reloads once when the server has a new build", async () => {
    const storage = memory();
    const read = serves(page("/assets/index-new.js"));
    expect(await shouldReloadForNewBuild(OLD, storage, read)).toBe(true);
    expect(await shouldReloadForNewBuild(OLD, storage, read)).toBe(false);
  });

  test("does not reload when the build is the same", async () => {
    expect(
      await shouldReloadForNewBuild(OLD, memory(), serves(page(OLD))),
    ).toBe(false);
  });

  test("does not reload when the server cannot say", async () => {
    const offline = async () => {
      throw new Error("offline");
    };
    expect(await shouldReloadForNewBuild(OLD, memory(), offline)).toBe(false);
    expect(
      await shouldReloadForNewBuild(OLD, memory(), serves("bad gateway", 502)),
    ).toBe(false);
    expect(
      await shouldReloadForNewBuild(OLD, memory(), serves("<p>proxy</p>")),
    ).toBe(false);
  });

  test("does not reload when the tab has no built entry", async () => {
    expect(
      await shouldReloadForNewBuild(null, memory(), serves(page(OLD))),
    ).toBe(false);
  });

  test("finds the entry by its path", () => {
    const doc = {
      querySelector: () => ({
        getAttribute: () => "http://10.0.0.36:8050/assets/index-a.js",
      }),
    } as unknown as Pick<Document, "querySelector">;
    expect(entryPath(doc)).toBe("/assets/index-a.js");
  });
});
