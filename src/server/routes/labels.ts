import type { LabelRequest } from "@common/api.ts";
import { isSerial } from "@common/validate.ts";
import { HttpError } from "../app.ts";
import type { Stores } from "../db/index.ts";
import { jsonResponse, type Router } from "../http.ts";

const MAX_LABEL_LENGTH = 64;

export function registerLabelRoutes(router: Router, stores: Stores): void {
  router.coreRoute("GET", "/api/devices/labels", "auth", () => jsonResponse(stores.labels.all()));

  router.coreRoute("PUT", "/api/devices/labels", "auth", async (ctx) => {
    const body = await ctx.json<Partial<LabelRequest>>();
    if (!isSerial(body?.serial)) throw new HttpError(400, "invalid serial");
    if (typeof body.label !== "string") throw new HttpError(400, "label required");
    const label = body.label.trim();
    if (label.length > MAX_LABEL_LENGTH || [...label].some((ch) => ch.charCodeAt(0) < 0x20))
      throw new HttpError(400, "invalid label");
    stores.labels.set(body.serial, label);
    return jsonResponse(stores.labels.all());
  });
}
