/** `import x from "…/scrcpy-server" with { type: "file" }` resolves to a path string (dev) or embedded-asset path (compiled). */
declare module "*/assets/scrcpy-server" {
  const path: string;
  export default path;
}
