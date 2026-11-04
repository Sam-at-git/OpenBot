import { describe, expect, test } from "bun:test";
import { computerRequestSeconds } from "../src/computer/request-seconds";

const bot = "/api/computers/agent_abc";

describe("computerRequestSeconds", () => {
  test("a command on a Bot's computer is not cut off at Bun's 10 s", () => {
    expect(computerRequestSeconds(`${bot}/exec`)).toBe(0);
  });

  test("every other route keeps Bun's own timeout", () => {
    expect(computerRequestSeconds(`${bot}/files/read`)).toBeUndefined();
    expect(computerRequestSeconds(`${bot}/exec/extra`)).toBeUndefined();
    expect(computerRequestSeconds("/api/computers//exec")).toBeUndefined();
    expect(computerRequestSeconds("/api/browser/open")).toBeUndefined();
  });
});
