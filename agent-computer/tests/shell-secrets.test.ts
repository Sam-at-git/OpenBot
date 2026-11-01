import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShell, maskSecrets, secretEnvironment } from "../src/shell";

describe("computer secrets in a command", () => {
  test("only real names with text values pass, and the computer's own names are refused", () => {
    expect(
      secretEnvironment({
        LLAMA_CLOUD_API_KEY: "llx-abc",
        PATH: "/evil",
        HOME: "/tmp",
        BASH_ENV: "/tmp/x",
        LD_PRELOAD: "x.so",
        HTTPS_PROXY: "http://x",
        EGRESS_PROXY_URL: "x",
        "BAD-NAME": "x",
        NUMBER: 3,
      }),
    ).toEqual({ LLAMA_CLOUD_API_KEY: "llx-abc" });
    expect(secretEnvironment(null)).toEqual({});
    expect(secretEnvironment(["x"])).toEqual({});
  });

  test("a printed value is replaced by its name, longest first", () => {
    expect(
      maskSecrets("key=llx-abcdef and llx-abc", {
        SHORT: "llx-abc",
        LONG: "llx-abcdef",
        TINY: "ab",
      }),
    ).toBe("key=[secret LONG] and [secret SHORT]");
  });

  test("a command sees the variable and its output never shows the value", async () => {
    const shell = createShell(mkdtempSync(join(tmpdir(), "shell-secrets-")), {
      PATH: process.env.PATH,
    });
    const result = await shell.run({
      command:
        'test -n "$LLAMA_CLOUD_API_KEY" && echo "set:$LLAMA_CLOUD_API_KEY" && echo "$LLAMA_CLOUD_API_KEY" >&2',
      env: { LLAMA_CLOUD_API_KEY: "llx-secret-value" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("set:[secret LLAMA_CLOUD_API_KEY]\n");
    expect(result.stderr).toBe("[secret LLAMA_CLOUD_API_KEY]\n");
  });
});
