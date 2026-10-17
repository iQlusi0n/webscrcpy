import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createStores, openDatabase } from "../../src/server/db/index.ts";
import { migrate, SCHEMA_VERSION } from "../../src/server/db/migrations.ts";

describe("migrations", () => {
  test("run twice idempotently", () => {
    const db = new Database(":memory:", { strict: true });
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    expect(version?.user_version).toBe(SCHEMA_VERSION);
    const stores = createStores(db);
    expect(stores.settings.getApp("passwordHash")).toBeNull();
    expect(stores.sessions.get("nope")).toBeNull();
  });
  test("refuses a database from the future", () => {
    const db = new Database(":memory:");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/newer/);
  });
  test("stores round-trip", () => {
    const stores = createStores(openDatabase(":memory:"));
    stores.labels.set("ABC123", "Pixel");
    expect(stores.labels.all()).toEqual({ ABC123: "Pixel" });
    stores.labels.set("ABC123", "");
    expect(stores.labels.all()).toEqual({});
    stores.settings.patchUserSettings({ theme: "light", gone: null });
    expect(stores.settings.getUserSettings()).toEqual({ theme: "light" });
    stores.settings.setDeviceSettings("ABC123", { maxFps: 30 });
    expect(stores.settings.getDeviceSettings("ABC123")).toEqual({ maxFps: 30 });
    stores.settings.setDeviceSettings("ABC123", {});
    expect(stores.settings.getDeviceSettings("ABC123")).toEqual({});
    stores.settings.setApp("passwordHash", "x");
    expect(stores.settings.getApp("passwordHash")).toBe("x");
    stores.settings.setApp("passwordHash", null);
    expect(stores.settings.getApp("passwordHash")).toBeNull();
    stores.sessions.create("h", 1, 2);
    expect(stores.sessions.deleteExpired(2)).toBe(1);
  });
});
