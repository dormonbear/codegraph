import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src/index';
import type { Node, Edge } from '../src/types';

let dir = '';
let cg: CodeGraph | null = null;
afterEach(() => {
  cg?.close();
  cg = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function node(id: string, kind: Node['kind'], qualifiedName: string, filePath: string): Node {
  return {
    id,
    kind,
    name: qualifiedName.split('.').pop() ?? qualifiedName,
    qualifiedName,
    filePath,
    language: 'apex',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
  } as Node;
}
function edge(source: string, target: string, kind: Edge['kind'], line: number): Edge {
  return { source, target, kind, line } as Edge;
}

describe('getObjectImpact — N+1 elimination & output equivalence', () => {
  it('rolls up field usage counts (deduped by file:line:kind) without per-field lookups', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-obj-'));
    cg = CodeGraph.initSync(dir);
    const q = (cg as unknown as { queries: any }).queries;

    const nodes: Node[] = [];
    // The object under test + 50 fields.
    nodes.push(node('obj:Acct__c', 'sobject', 'Acct__c', 'objects/Acct__c/Acct__c.object-meta.xml'));
    for (let i = 0; i < 50; i++) {
      nodes.push(node(`fld:F${i}`, 'sobject_field', `Acct__c.F${i}__c`, `objects/Acct__c/fields/F${i}__c.field-meta.xml`));
    }
    // Sibling objects that must NOT leak into Acct__c's field list. The first
    // guards the old `_`-as-LIKE-wildcard bug; both are excluded by the range scan.
    nodes.push(node('obj:Acct__cc', 'sobject', 'Acct__cc', 'objects/Acct__cc/Acct__cc.object-meta.xml'));
    nodes.push(node('fld:sibling', 'sobject_field', 'Acct__cc.Foo__c', 'objects/Acct__cc/fields/Foo__c.field-meta.xml'));
    // Two Apex source nodes that reference fields.
    nodes.push(node('cls:A', 'class', 'ClsA', 'classes/ClsA.cls'));
    nodes.push(node('cls:B', 'class', 'ClsB', 'classes/ClsB.cls'));
    q.insertNodes(nodes);

    // F0: A.cls:10 read (x2 → dedups to 1) + B.cls:20 read → 2 distinct sites.
    // F1: A.cls:5 soql_select → 1.
    // F2: A.cls:7 read + A.cls:7 soql_select → 2 (kind differs, same line).
    // F3..F49: no usages → 0.
    q.insertEdges([
      edge('cls:A', 'fld:F0', 'field_read', 10),
      edge('cls:A', 'fld:F0', 'field_read', 10),
      edge('cls:B', 'fld:F0', 'field_read', 20),
      edge('cls:A', 'fld:F1', 'field_soql_select', 5),
      edge('cls:A', 'fld:F2', 'field_read', 7),
      edge('cls:A', 'fld:F2', 'field_soql_select', 7),
      // a usage on the sibling object's field — must not be attributed to Acct__c.
      edge('cls:A', 'fld:sibling', 'field_read', 99),
    ]);

    // N+1 guard: count getNodeById calls during getObjectImpact. The old per-field
    // getFieldUsages() path calls it once per usage edge; the grouped query path
    // resolves source files via a SQL join, so it must be 0 here (no object-level
    // usages / metadata / relationships in this fixture).
    let nodeByIdCalls = 0;
    const orig = q.getNodeById.bind(q);
    q.getNodeById = (id: string) => { nodeByIdCalls++; return orig(id); };

    const impact = cg.getObjectImpact('Acct__c');

    expect(impact.object?.id).toBe('obj:Acct__c');
    expect(impact.fields).toHaveLength(50); // sibling field excluded
    const byName = new Map(impact.fields.map((f) => [f.qualifiedName, f.usageCount]));
    expect(byName.get('Acct__c.F0__c')).toBe(2);
    expect(byName.get('Acct__c.F1__c')).toBe(1);
    expect(byName.get('Acct__c.F2__c')).toBe(2);
    expect(byName.get('Acct__c.F3__c')).toBe(0);
    expect(byName.has('Acct__cc.Foo__c')).toBe(false);
    // sorted by usageCount desc
    expect(impact.fields[0].usageCount).toBeGreaterThanOrEqual(impact.fields[1].usageCount);
    // N+1 gone.
    expect(nodeByIdCalls).toBe(0);
  });
});
