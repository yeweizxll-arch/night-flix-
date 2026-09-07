import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('gives each admin form a unique name so retained modals cannot steal field labels', () => {
  const names = new Set<string>();
  const failures: string[] = [];
  const directory = resolve(process.cwd(), 'src/pages');
  for (const file of readdirSync(directory).filter(file => file.endsWith('.tsx') && !file.includes('.spec.'))) {
    const source = ts.createSourceFile(file, readFileSync(resolve(directory, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'Form') {
        const name = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === 'name');
        const value = name && ts.isJsxAttribute(name) && name.initializer && ts.isStringLiteral(name.initializer) ? name.initializer.text : undefined;
        if (!value || names.has(value)) failures.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        if (value) names.add(value);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(names.size).toBeGreaterThan(30);
  expect(failures).toEqual([]);
});
