/**
 * Backpressure shedder for one /ws/stream socket (DESIGN_DECISIONS D6). Pure state machine
 * driven by `ws.getBufferedAmount()`; the caller performs the sends and the RESET_VIDEO write.
 *
 *   flowing ──(buffered > high)──▶ congested ──(buffered ≤ low)──▶ awaiting-keyframe ──(keyframe)──▶ flowing
 *
 * Config packets are never shed. In `congested` every media packet is dropped; in
 * `awaiting-keyframe` video deltas are dropped until the keyframe that follows the forced reset,
 * while audio resumes immediately.
 */
export type CongestionState = "flowing" | "congested" | "awaiting-keyframe";

export interface CongestionDecision {
  send: boolean;
  /** caller must write ControlMsg.RESET_VIDEO to the device now */
  reset: boolean;
  /** state transition to log, if any */
  event?: "congested" | "drained" | "resumed";
}

export const CONGESTION_HIGH_WATER = 4 * 1024 * 1024;
export const CONGESTION_LOW_WATER = 1 * 1024 * 1024;

export interface MediaPacketInfo {
  channel: "video" | "audio";
  config: boolean;
  keyframe: boolean;
}

export class CongestionController {
  state: CongestionState = "flowing";
  dropped = 0;

  constructor(
    private readonly high = CONGESTION_HIGH_WATER,
    private readonly low = CONGESTION_LOW_WATER,
  ) {}

  decide(buffered: number, packet: MediaPacketInfo): CongestionDecision {
    let event: CongestionDecision["event"];
    let reset = false;
    if (this.state !== "congested" && buffered > this.high) {
      this.state = "congested";
      event = "congested";
    } else if (this.state === "congested" && buffered <= this.low) {
      this.state = "awaiting-keyframe";
      event = "drained";
      reset = true;
    }
    if (packet.config) return { send: true, reset, event };
    if (this.state === "congested") {
      this.dropped += 1;
      return { send: false, reset, event };
    }
    if (this.state === "awaiting-keyframe" && packet.channel === "video") {
      if (!packet.keyframe) {
        this.dropped += 1;
        return { send: false, reset, event };
      }
      this.state = "flowing";
      return { send: true, reset, event: event ?? "resumed" };
    }
    return { send: true, reset, event };
  }
}
