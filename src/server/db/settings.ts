/** settings (UI key/value), device_settings (per serial, one JSON blob), app_settings (server-side state). */
import type { Database } from "bun:sqlite";
import type { DeviceStreamSettings, UserSettings } from "@common/api.ts";
import type { LockoutState } from "../auth/lockout.ts";

export interface AppSettingValues {
  passwordHash: string | null;
  lockout: LockoutState | null;
}
export type AppSettingKey = keyof AppSettingValues;

export class SettingsStore {
  constructor(private readonly db: Database) {}

  // ---- UI settings

  getUserSettings(): UserSettings {
    const rows = this.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
    // Own data properties only: a stored "__proto__" key must not re-parent the result object.
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  }

  /** Merges `patch`; a key whose value is `null` or `undefined` is removed. */
  patchUserSettings(patch: Record<string, unknown>): UserSettings {
    const upsert = this.db.query(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const del = this.db.query("DELETE FROM settings WHERE key = ?");
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) del.run(key);
        else upsert.run(key, JSON.stringify(value));
      }
    })();
    return this.getUserSettings();
  }

  resetUserSettings(): void {
    this.db.run("DELETE FROM settings");
  }

  // ---- per-device stream settings

  getDeviceSettings(serial: string): DeviceStreamSettings {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM device_settings WHERE serial = ?")
      .get(serial);
    return row ? (JSON.parse(row.value) as DeviceStreamSettings) : {};
  }

  setDeviceSettings(serial: string, value: DeviceStreamSettings): void {
    if (Object.keys(value).length === 0) {
      this.db.run("DELETE FROM device_settings WHERE serial = ?", [serial]);
      return;
    }
    this.db.run(
      "INSERT INTO device_settings (serial, value) VALUES (?, ?) ON CONFLICT(serial) DO UPDATE SET value = excluded.value",
      [serial, JSON.stringify(value)],
    );
  }

  // ---- app settings

  getApp<K extends AppSettingKey>(key: K): AppSettingValues[K] | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(key);
    return row ? (JSON.parse(row.value) as AppSettingValues[K]) : null;
  }

  /** `null` deletes the key. */
  setApp<K extends AppSettingKey>(key: K, value: AppSettingValues[K]): void {
    if (value === null) {
      this.db.run("DELETE FROM app_settings WHERE key = ?", [key]);
      return;
    }
    this.db.run(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, JSON.stringify(value)],
    );
  }
}
