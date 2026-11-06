// assets imported with { type: "file" } are paths (inside a compiled app: embedded ones)
declare module "*.svg" {
  const path: string;
  export default path;
}
