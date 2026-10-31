// The attention favicon: a 64px red disc with the count ("9+" past nine) while the tab is in
// the background and someone is needed. The page's own icons come back the moment it clears.

export const BADGE_COLOR = "#e5484d";

export const badgeLabel = (count: number): string | null => (count <= 0 ? null : count > 9 ? "9+" : String(Math.floor(count)));

export function drawBadge(count: number, doc: Document = document): string | null {
  const label = badgeLabel(count);
  if (!label) return null;
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = BADGE_COLOR;
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `600 ${label.length > 1 ? 30 : 40}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 32, 34);
  return canvas.toDataURL("image/png");
}

const ICON_SELECTOR = 'link[rel="icon"], link[rel="shortcut icon"]';
const SWAPPED = ["href", "type", "sizes"] as const;

/**
 * Points the page icons at a badge and returns the restore function. The links are edited in place,
 * never removed: Next renders them, and React must find them where it left them.
 */
export function installBadge(image: string, doc: Document = document): () => void {
  let links = Array.from(doc.head.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR));
  let added: HTMLLinkElement | null = null;
  if (links.length === 0) {
    added = doc.createElement("link");
    added.rel = "icon";
    doc.head.append(added);
    links = [added];
  }
  const saved = links.map((link) => ({ link, attrs: SWAPPED.map((name) => [name, link.getAttribute(name)] as const) }));
  for (const link of links) {
    link.setAttribute("type", "image/png");
    link.setAttribute("sizes", "64x64");
    link.setAttribute("href", image);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (added) return added.remove();
    for (const { link, attrs } of saved) {
      for (const [name, value] of attrs) {
        if (value === null) link.removeAttribute(name);
        else link.setAttribute(name, value);
      }
    }
  };
}
