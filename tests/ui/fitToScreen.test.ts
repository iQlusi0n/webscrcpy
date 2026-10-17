import { describe, expect, test } from "bun:test";
import { fitMaxSize, resolveMaxSize } from "../../src/app/ui/fitToScreen.ts";

describe("fitMaxSize", () => {
  test("uses the longer viewport side in device pixels, rounded down to a multiple of 8", () => {
    expect(fitMaxSize(1366, 768, 1)).toBe(1360);
    expect(fitMaxSize(768, 1366, 1)).toBe(1360);
    expect(fitMaxSize(1440, 900, 2)).toBe(2880);
  });

  test("caps at what the server accepts and tolerates bad inputs", () => {
    expect(fitMaxSize(8000, 4000, 2)).toBe(7680);
    expect(fitMaxSize(0, 0, 1)).toBe(0);
    expect(fitMaxSize(1000, 500, 0)).toBe(1000);
    expect(fitMaxSize(Number.NaN, 500, 1)).toBe(0);
  });
});

describe("resolveMaxSize", () => {
  const viewport = { width: 1920, height: 1080, dpr: 1 };

  test("fitToScreen replaces the saved maxSize", () => {
    expect(resolveMaxSize({ fitToScreen: true, maxSize: 480 }, viewport).maxSize).toBe(1920);
  });

  test("explicit maxSize is kept when fitToScreen is off or unset", () => {
    expect(resolveMaxSize({ fitToScreen: false, maxSize: 480 }, viewport).maxSize).toBe(480);
    expect(resolveMaxSize({ maxSize: 480 }, viewport).maxSize).toBe(480);
  });
});
