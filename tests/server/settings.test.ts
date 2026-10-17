import { describe, expect, test } from "bun:test";
import { createStores, openDatabase } from "../../src/server/db/index.ts";
import { MAX_USER_SETTINGS_KEYS, validateUserPatch } from "../../src/server/routes/settings.ts";

describe("validateUserPatch", () => {
  test("rejects prototype-polluting keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => validateUserPatch(JSON.parse(`{"${key}": {"x": 1}}`), [])).toThrow(/invalid key/);
    }
  });

  test("caps the stored key count, not just the request", () => {
    const existing = Array.from({ length: MAX_USER_SETTINGS_KEYS }, (_, i) => `k${i}`);
    expect(() => validateUserPatch({ extra: 1 }, existing)).toThrow(/too many keys/);
    expect(() => validateUserPatch({ k0: 2 }, existing)).not.toThrow(); // overwrite keeps the count
    expect(() => validateUserPatch({ k0: null, extra: 1 }, existing)).not.toThrow(); // swap keeps the count
  });
});

describe("SettingsStore.getUserSettings", () => {
  test("a stored __proto__ row becomes an own property", () => {
    const stores = createStores(openDatabase(":memory:"));
    stores.settings.patchUserSettings(JSON.parse('{"__proto__": {"polluted": true}, "theme": "dark"}'));
    const out = stores.settings.getUserSettings();
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.theme).toBe("dark");
  });
});
