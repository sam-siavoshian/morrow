import { describe, expect, test } from "bun:test";
import { inline, parseMarkdown, plainText, type Block, type Inline } from "./markdown";

const links = (nodes: Inline[] | Block[]): string[] => {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if ((node.t === "link" || node.t === "image") && typeof node.href === "string") out.push(node.href);
    for (const v of Object.values(node)) walk(v);
  };
  walk(nodes);
  return out;
};

describe("parseMarkdown: safety", () => {
  test("raw HTML stays text", () => {
    const tree = parseMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">');
    expect(tree).toEqual([{ t: "p", c: [{ t: "text", v: "<script>alert(1)</script>" }, { t: "br" }, { t: "text", v: '<img src=x onerror="alert(1)">' }] }]);
  });

  test("only http(s) links survive; others become their text", () => {
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "//evil.example", "https://user:pw@evil.example", "file:///etc/passwd"]) {
      const nodes = inline(`[click](${bad})`);
      expect(links(nodes)).toEqual([]);
      expect(plainText(nodes)).toBe("click");
    }
    expect(links(inline("[ok](https://github.com/acme/web/pull/1)"))).toEqual(["https://github.com/acme/web/pull/1"]);
    expect(links(inline("<https://example.com/a>"))).toEqual(["https://example.com/a"]);
    expect(links(inline("see https://example.com/x."))).toEqual(["https://example.com/x"]);
  });

  test("images never load: they become a link (http) or a label", () => {
    expect(inline("![diagram](https://user-images.githubusercontent.com/1.png)")).toEqual([{ t: "image", href: "https://user-images.githubusercontent.com/1.png", alt: "diagram" }]);
    expect(inline("![x](javascript:alert(1))")).toEqual([{ t: "image", href: null, alt: "x" }]);
  });

  test("a link cannot hold a link", () => {
    expect(inline("[a [b](https://b.example) c](https://a.example)")).toEqual([
      { t: "link", href: "https://a.example/", c: [{ t: "text", v: "a " }, { t: "text", v: "b" }, { t: "text", v: " c" }] },
    ]);
  });

  test("hostile input stays fast and bounded", () => {
    const inputs = ["*".repeat(20_000), "_a".repeat(10_000), "[".repeat(20_000), "`".repeat(20_000), "> ".repeat(5_000) + "x", "- ".repeat(5_000) + "x", "~~a".repeat(7_000)];
    for (const input of inputs) {
      const start = performance.now();
      parseMarkdown(input);
      expect(performance.now() - start).toBeLessThan(500);
    }
    // Nesting is capped, not recursed without end.
    expect(JSON.stringify(parseMarkdown(">".repeat(200) + " deep")).length).toBeLessThan(2_000);
  });

  test("HTML comments are dropped like GitHub does", () => {
    expect(parseMarkdown("<!-- template\nhint -->Real text")).toEqual([{ t: "p", c: [{ t: "text", v: "Real text" }] }]);
  });
});

describe("parseMarkdown: structure", () => {
  test("headings, fences, quotes, rules", () => {
    const tree = parseMarkdown("## Summary\n\n```ts\nconst a = '<b>';\n```\n\n> quoted **bold**\n\n---");
    expect(tree).toEqual([
      { t: "h", level: 2, c: [{ t: "text", v: "Summary" }] },
      { t: "code", lang: "ts", text: "const a = '<b>';" },
      { t: "quote", c: [{ t: "p", c: [{ t: "text", v: "quoted " }, { t: "strong", c: [{ t: "text", v: "bold" }] }] }] },
      { t: "hr" },
    ]);
  });

  test("lists, task lists and ordered starts", () => {
    const tree = parseMarkdown("- [x] done\n- [ ] todo\n  - nested\n\n3. three\n4. four");
    expect(tree[0]).toMatchObject({ t: "list", ordered: false, items: [{ task: true }, { task: false }] });
    const todo = (tree[0] as Extract<Block, { t: "list" }>).items[1]!.c;
    expect(todo[1]).toMatchObject({ t: "list", items: [{ task: null, c: [{ t: "p", c: [{ t: "text", v: "nested" }] }] }] });
    expect(tree[1]).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  test("tables", () => {
    const tree = parseMarkdown("| a | b |\n|---|:-:|\n| `1` | x \\| y |");
    expect(tree).toEqual([{ t: "table", head: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]], rows: [[[{ t: "code", v: "1" }], [{ t: "text", v: "x | y" }]]] }]);
  });

  test("emphasis rules: snake_case stays, escapes work, code is literal", () => {
    expect(inline("use snake_case_name here")).toEqual([{ t: "text", v: "use snake_case_name here" }]);
    expect(inline("*em* and **strong** and ~~gone~~")).toEqual([
      { t: "em", c: [{ t: "text", v: "em" }] },
      { t: "text", v: " and " },
      { t: "strong", c: [{ t: "text", v: "strong" }] },
      { t: "text", v: " and " },
      { t: "del", c: [{ t: "text", v: "gone" }] },
    ]);
    expect(inline("\\*not em\\*")).toEqual([{ t: "text", v: "*not em*" }]);
    expect(inline("`**raw** <b>`")).toEqual([{ t: "code", v: "**raw** <b>" }]);
    expect(inline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
  });

  test("empty input is empty", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});
