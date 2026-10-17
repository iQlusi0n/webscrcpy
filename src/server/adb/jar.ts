/** Push the bundled scrcpy-server to the device unless the copy there already has the same size. */
import type { Adb } from "@yume-chan/adb";
import type { ReadableStream as TangoReadableStream } from "@yume-chan/stream-extra";
import { SCRCPY_DEVICE_PATH } from "@common/scrcpy.ts";
import type { Logger } from "../app.ts";

export async function ensureServerJar(adb: Adb, localPath: string, log: Logger): Promise<void> {
  const file = Bun.file(localPath);
  const localSize = file.size;
  if (localSize <= 0) throw new Error(`scrcpy-server missing or empty at ${localPath}`);
  const sync = await adb.sync();
  try {
    let remoteSize = -1;
    try {
      remoteSize = Number((await sync.lstat(SCRCPY_DEVICE_PATH)).size);
    } catch {
      remoteSize = -1;
    }
    if (remoteSize === localSize) return;
    log.info(`pushing scrcpy-server (${localSize} bytes) to ${adb.serial}:${SCRCPY_DEVICE_PATH}`);
    await sync.write({
      filename: SCRCPY_DEVICE_PATH,
      file: file.stream() as unknown as TangoReadableStream<Uint8Array>,
      permission: 0o644,
      mtime: Math.floor(Date.now() / 1000),
    });
  } finally {
    await sync.dispose().catch(() => undefined);
  }
}
