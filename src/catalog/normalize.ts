const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const NUM = /^-?\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Replaces ID-like path segments with placeholders so recorded URLs group into endpoint templates. */
export function templateSegment(seg: string): string {
  if (seg === "") return seg;
  let s: string;
  try {
    s = decodeURIComponent(seg);
  } catch {
    s = seg;
  }
  if (NUM.test(s)) return "{num}";
  if (UUID.test(s)) return "{uuid}";
  if (HEX.test(s)) return "{hex}";
  if (DATE.test(s)) return "{date}";
  if (s.includes("@")) return "{email}";
  // Mixed tokens such as INV-100234 or A12B34C56: contain digits and look like identifiers, not words.
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits >= 3 && digits / s.length >= 0.3) return "{id}";
  if (s.length > 40) return "{token}";
  return seg;
}

export function templatePath(pathname: string): string {
  return pathname
    .split("/")
    .map(templateSegment)
    .join("/")
    .replace(/\/$/, "");
}

export function endpointKey(method: string, pathTemplate: string): string {
  return `${method.toUpperCase()} ${pathTemplate}`;
}

/** Builds a regex for a page config path such as "invoices/payment-activity/{transactionId}". */
export function pagePathRegex(pagePath: string): RegExp {
  const pattern = pagePath
    .split("/")
    .map((seg) => (/^\{[^}]+\}$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}$`);
}
