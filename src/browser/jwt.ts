export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Token expiry, epoch seconds (0 when unknown). */
export function decodeJwtExp(token: string): number {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" ? exp : 0;
}
