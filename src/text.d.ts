// Files imported with { type: "text" } are their contents, and with
// { type: "file" } their path, as a string (Bun embeds both in a compiled
// executable).
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.css" {
  const path: string;
  export default path;
}
