import type { LoginRequest, LoginResponse, SetPasswordRequest } from "@common/api.ts";
import { HttpError } from "../app.ts";
import type { AuthService } from "../auth/index.ts";
import { isAcceptablePassword, MIN_PASSWORD_LENGTH } from "../auth/password.ts";
import { clearSessionCookie, sessionCookie } from "../auth/session.ts";
import { jsonResponse, type Router } from "../http.ts";

export function registerAuthRoutes(router: Router, auth: AuthService): void {
  router.coreRoute("POST", "/api/auth/login", "public", async (ctx) => {
    if (auth.mode() === "off") throw new HttpError(409, "no password is set");
    const body = await ctx.json<Partial<LoginRequest>>();
    if (typeof body?.password !== "string") throw new HttpError(400, "password required");
    const result = auth.login(body.password);
    if (!result.ok) {
      const res: LoginResponse =
        result.reason === "locked"
          ? { ok: false, reason: "locked", retryAfterMs: result.retryAfterMs }
          : { ok: false, reason: "invalid" };
      return jsonResponse(res, 401);
    }
    const res: LoginResponse = { ok: true };
    return jsonResponse(res, 200, { "Set-Cookie": sessionCookie(result.token, ctx.cookieAttrs) });
  });

  router.coreRoute("POST", "/api/auth/logout", "auth", (ctx) => {
    auth.logoutAll();
    router.sockets.closeAllSessions();
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(ctx.cookieAttrs) });
  });

  // Gate is 'auth': identical to public while mode is 'off' (first password), session-only once set.
  router.coreRoute("POST", "/api/auth/password", "auth", async (ctx) => {
    if (auth.fromEnv) throw new HttpError(409, "password is set by AUTH_PASSWORD and cannot be changed here");
    const body = await ctx.json<Partial<SetPasswordRequest>>();
    if (typeof body?.newPassword !== "string") throw new HttpError(400, "newPassword required");
    if (body.newPassword !== "" && !isAcceptablePassword(body.newPassword))
      throw new HttpError(400, `password must be ${MIN_PASSWORD_LENGTH}+ characters`);
    if (ctx.principal.mode === "password") {
      if (typeof body.currentPassword !== "string" || !auth.verifyCurrent(body.currentPassword))
        throw new HttpError(403, "current password is incorrect");
    }
    auth.setPassword(body.newPassword);
    router.sockets.closeAllSessions("password changed");
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(ctx.cookieAttrs) });
  });
}
