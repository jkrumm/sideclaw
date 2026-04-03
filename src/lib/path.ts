export function encodePath(path: string): string {
  return btoa(path).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function decodePath(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (base64.length % 4)) % 4;
  return atob(base64 + "=".repeat(padding));
}
