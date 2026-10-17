/** Stats overlay drawn on its own canvas layer; `render` is called once per second. */
import type { StreamStats } from "./types.ts";

export function formatBitrate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8;
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbps`;
  if (bits >= 1_000) return `${(bits / 1_000).toFixed(0)} kbps`;
  return `${bits} bps`;
}

export function statsLines(stats: StreamStats): string[] {
  const lines = [`${stats.resolution}  ${stats.codec}`];
  if (stats.encoder) lines.push(stats.encoder);
  lines.push(formatBitrate(stats.bytesPerSecond));
  lines.push(`in ${stats.inputFps} · dec ${stats.decodedFps} · drop ${stats.droppedFps} fps`);
  return lines;
}

export class StatsOverlay {
  private visible = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.hidden = !visible;
    if (!visible) this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  render(stats: StreamStats): void {
    if (!this.visible) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const lines = statsLines(stats);
    const fontPx = 13 * dpr;
    const pad = 8 * dpr;
    const lineH = fontPx * 1.4;
    ctx.font = `${fontPx}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    let boxW = 0;
    for (const line of lines) boxW = Math.max(boxW, ctx.measureText(line).width);
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(pad, pad, boxW + pad * 2, lines.length * lineH + pad * 2);
    ctx.fillStyle = "#fff";
    lines.forEach((line, i) => ctx.fillText(line, pad * 2, pad * 2 + i * lineH));
  }
}
