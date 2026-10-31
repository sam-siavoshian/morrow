import { describe, expect, test } from "bun:test";
import { CliKind } from "@morrow/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { HARNESS_LABEL, HARNESSES, HarnessIcon, HarnessStack } from "./harness-icon";

describe("HarnessIcon", () => {
  test("every CLI has a label, sits in the harness list and draws a mark", () => {
    expect([...HARNESSES].sort()).toEqual([...CliKind.options].sort());
    for (const cli of CliKind.options) {
      const html = renderToStaticMarkup(<HarnessIcon cli={cli} size={16} />);
      expect(html).toContain(`aria-label="${HARNESS_LABEL[cli]}"`);
      expect(html).toContain("<svg");
      expect(html).toContain("<path");
    }
  });

  test("Codex draws its colour mark at the full tile size", () => {
    const html = renderToStaticMarkup(<HarnessIcon cli="codex" size={16} />);
    expect(html).toContain('width="16" height="16"');
    expect(html).toContain("linearGradient");
  });

  test("Gemini CLI draws the four-colour sparkle inset on a white tile", () => {
    const html = renderToStaticMarkup(<HarnessIcon cli="gemini" size={16} />);
    expect(html).toContain("bg-white");
    expect(html).toContain('width="11.52" height="11.52"');
    expect(html).toContain('fill="#3186FF"');
    expect([...html.matchAll(/<linearGradient/g)]).toHaveLength(3);
  });

  test("two colour marks on one page never share a gradient id", () => {
    const html = renderToStaticMarkup(<HarnessStack clis={["codex", "gemini", "codex"]} size={16} />);
    const ids = [...html.matchAll(/<linearGradient[^>]* id="([^"]+)"/g)].map((m) => m[1]);
    // One gradient per Codex mark, three layers (green, red, yellow) for the Gemini sparkle.
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(html).toContain(`url(#${id})`);
  });

  test("a decorative icon is hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<HarnessIcon cli="grok" decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("aria-label");
  });
});
