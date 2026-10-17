import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/server/config.ts";

describe("loadConfig", () => {
  test("AUTH_PASSWORD is used verbatim; blank means unset", () => {
    const DATA_ROOT = mkdtempSync(join(tmpdir(), "wsc-cfg-"));
    expect(loadConfig({ DATA_ROOT, AUTH_PASSWORD: " pw with spaces " }).authPasswordFromEnv).toBe(" pw with spaces ");
    expect(loadConfig({ DATA_ROOT, AUTH_PASSWORD: "   " }).authPasswordFromEnv).toBeUndefined();
  });

  test("creates the data root owner-only", () => {
    const DATA_ROOT = join(mkdtempSync(join(tmpdir(), "wsc-cfg-")), "nested", "root");
    loadConfig({ DATA_ROOT });
    expect(statSync(DATA_ROOT).mode & 0o777).toBe(0o700);
  });
});
