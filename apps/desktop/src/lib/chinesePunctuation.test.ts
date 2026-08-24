import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CJK = /[\u3400-\u9fff]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(path);
    }
    if (![".ts", ".tsx"].includes(extname(entry.name)) || entry.name.includes(".test.")) {
      return [];
    }
    return [path];
  });
}

function proseOnly(value: string): string {
  return value
    .replace(/\[[^\]]+\]\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(?:^|\s)[^\s/]+\/[^\s/]+\.[A-Za-z0-9]+(?=\s|$)/g, "");
}

function violation(value: string): string | null {
  const prose = proseOnly(value);
  if (!CJK.test(prose) && !/[「」『』]/.test(prose)) {
    return /¤,¤。/.test(prose) ? "中文句内使用了半角标点" : null;
  }
  if (/[「」『』]/.test(prose)) return "使用了非大陆中文常用引号";
  if (/\.\.\.|(^|[^…])…([^…]|$)/.test(prose)) return "省略号不是六点形式";
  if (/[\u3400-\u9fff”’）》】）][,:;!?]|[,:;!?][\u3400-\u9fff“‘（《【]|¤,|,¤/.test(prose)) {
    return "中文句内使用了半角标点";
  }
  if (/\s\/\s|[\u3400-\u9fff]\/[\u3400-\u9fffA-Za-z@]|[A-Za-z@\u3400-\u9fff]\/[\u3400-\u9fff]/.test(prose)) {
    return "中文并列或选择关系使用了斜杠";
  }
  if (/[，：；！？] +/.test(prose)) return "中文标点后存在多余空格";
  if (/[()]/.test(prose)) return "中文语境使用了半角圆括号";
  return null;
}

describe("中文界面标点", () => {
  it("所有用户可见字符串遵循统一规范", () => {
    const failures: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      let openingQuotes = 0;
      let closingQuotes = 0;

      const inspect = (node: ts.Node, value: string, countQuotes = true) => {
        if (countQuotes) {
          openingQuotes += value.match(/“/g)?.length ?? 0;
          closingQuotes += value.match(/”/g)?.length ?? 0;
        }
        const reason = violation(value);
        if (!reason) return;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        failures.push(`${relative(SRC_ROOT, file)}:${line + 1} ${reason}: ${JSON.stringify(value)}`);
      };

      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          inspect(node, node.text);
        } else if (ts.isTemplateExpression(node)) {
          inspect(node, node.head.text + node.templateSpans.map((span) => `¤${span.literal.text}`).join(""));
          for (const span of node.templateSpans) visit(span.expression);
          return;
        } else if (ts.isJsxText(node)) {
          inspect(node, node.getText(sourceFile));
        } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
          const composite = node.children
            .map((child) => {
              if (ts.isJsxText(child)) return child.getText(sourceFile);
              if (ts.isJsxExpression(child) && child.expression) return "¤";
              return "";
            })
            .join("");
          inspect(node, composite, false);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      if (openingQuotes !== closingQuotes) {
        failures.push(`${relative(SRC_ROOT, file)} 中文弯引号未成对`);
      }
    }

    expect(failures).toEqual([]);
  });
});
