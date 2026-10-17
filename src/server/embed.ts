/**
 * Side-effect imports that make `bun build --compile` embed the browser bundle (listed in
 * `Bun.embeddedFiles`, read by static.ts). In dev these resolve to disk paths and are unused.
 * Requires `--asset-naming="[name].[ext]"` so the embedded names match the request paths.
 */
import "../../dist/public/index.html" with { type: "file" };
import "../../dist/public/index.js" with { type: "file" };
import "../../dist/public/index.css" with { type: "file" };
import "../../dist/public/favicon.svg" with { type: "file" };
