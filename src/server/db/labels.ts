import type { Database } from "bun:sqlite";

export class LabelStore {
  constructor(private readonly db: Database) {}

  all(): Record<string, string> {
    const rows = this.db.query<{ serial: string; label: string }, []>("SELECT serial, label FROM device_labels").all();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.serial] = r.label;
    return out;
  }

  /** Empty label deletes. */
  set(serial: string, label: string): void {
    if (label === "") {
      this.db.run("DELETE FROM device_labels WHERE serial = ?", [serial]);
      return;
    }
    this.db.run("INSERT INTO device_labels (serial, label) VALUES (?, ?) ON CONFLICT(serial) DO UPDATE SET label = excluded.label", [serial, label]);
  }
}
