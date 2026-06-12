import { Node, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * SalesforceMetadataExtractor — (viva-local, NEVER upstream) indexes the
 * declarative metadata that REFERENCES SObject fields and/or objects but breaks
 * SILENTLY when a field/object changes type or is removed:
 *  - Page Layouts + Validation Rules → field_metadata_ref AND object_metadata_ref
 *  - Flows, Permission Sets / Profiles, Record Types → object_metadata_ref
 *
 * Each metadata file becomes one `component` node (signature = "Layout" /
 * "ValidationRule" / "Flow" / "PermissionSet" / "Profile" / "RecordType") with
 * `field_metadata_ref` / `object_metadata_ref` edges, so codegraph_field_impact /
 * codegraph_object_impact can warn "referenced by <X>" before a reviewer
 * deletes the field/object.
 *
 *  - Layout `<Object>-<Label>.layout-meta.xml` (in the flat `layouts/` dir): the
 *    object is the filename prefix before the first `-`; fields are `<field>X</field>`.
 *  - ValidationRule `objects/<Object>/validationRules/<Name>.validationRule-meta.xml`:
 *    the object is the path segment; fields are the `__c` tokens in the formula.
 */
export class SalesforceMetadataExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      if (/\.layout-meta\.xml$/i.test(this.filePath)) this.extractLayout();
      else if (/\.validationRule-meta\.xml$/i.test(this.filePath)) this.extractValidationRule();
      else if (/\.flow-meta\.xml$/i.test(this.filePath)) this.extractFlow();
      else if (/\.(permissionset|profile)-meta\.xml$/i.test(this.filePath)) this.extractObjectPermissions();
      else if (/\.recordType-meta\.xml$/i.test(this.filePath)) this.extractRecordType();
    } catch (error) {
      this.errors.push({
        message: `Salesforce metadata extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }
    return {
      nodes: this.nodes,
      edges: [],
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private fileName(): string {
    return this.filePath.split(/[/\\]/).pop() || this.filePath;
  }

  private componentNode(name: string, kindLabel: string): string {
    const lines = this.source.split('\n');
    const node: Node = {
      id: generateNodeId(this.filePath, 'component', name, 1),
      kind: 'component',
      name,
      qualifiedName: `${this.filePath}::${name}`,
      filePath: this.filePath,
      language: 'apex',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      signature: kindLabel,
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node.id;
  }

  private pushFieldRef(fromId: string, object: string, field: string): void {
    this.unresolvedReferences.push({
      fromNodeId: fromId,
      referenceName: `@field/${object}.${field}`,
      referenceKind: 'field_metadata_ref',
      line: 1,
      column: 0,
      filePath: this.filePath,
      language: 'apex',
    });
  }

  /** The metadata component also references its OBJECT — surfaced by
   * object_impact so deleting/renaming the object flags this Layout/VR. */
  private pushObjectRef(fromId: string, object: string): void {
    this.unresolvedReferences.push({
      fromNodeId: fromId,
      referenceName: `@object/${object}`,
      referenceKind: 'object_metadata_ref',
      line: 1,
      column: 0,
      filePath: this.filePath,
      language: 'apex',
    });
  }

  /** Layout: object = filename prefix before the first `-`; fields = `<field>X</field>`. */
  private extractLayout(): void {
    const base = this.fileName().replace(/\.layout-meta\.xml$/i, '');
    const dash = base.indexOf('-');
    if (dash <= 0) return;
    const object = base.slice(0, dash);
    const label = base.slice(dash + 1) || base;
    const fromId = this.componentNode(label, 'Layout');
    this.pushObjectRef(fromId, object);
    const seen = new Set<string>();
    for (const m of this.source.matchAll(/<field>([^<]+)<\/field>/gi)) {
      const field = m[1]!.trim();
      if (!field || seen.has(field)) continue;
      seen.add(field);
      this.pushFieldRef(fromId, object, field);
    }
  }

  /** ValidationRule: object from the path; fields = `__c` tokens in the formula. */
  private extractValidationRule(): void {
    const parts = this.filePath.split(/[/\\]/);
    const vrIdx = parts.lastIndexOf('validationRules');
    const object = vrIdx >= 1 ? parts[vrIdx - 1] : null;
    if (!object) return;
    const name = this.fileName().replace(/\.validationRule-meta\.xml$/i, '');
    const formula = this.source.match(/<errorConditionFormula>([\s\S]*?)<\/errorConditionFormula>/i)?.[1] ?? '';
    if (!formula) return;
    const fromId = this.componentNode(name, 'ValidationRule');
    this.pushObjectRef(fromId, object);
    const seen = new Set<string>();
    for (const m of formula.matchAll(/\b([A-Za-z_]\w*__c)\b/g)) {
      const field = m[1]!;
      if (seen.has(field)) continue;
      seen.add(field);
      this.pushFieldRef(fromId, object, field);
    }
  }

  /** Flow: every `<object>X</object>` it reads/creates/updates → object_metadata_ref. */
  private extractFlow(): void {
    const name = this.fileName().replace(/\.flow-meta\.xml$/i, '');
    const objects = new Set<string>();
    for (const m of this.source.matchAll(/<object>([^<]+)<\/object>/gi)) {
      const o = m[1]!.trim();
      if (o) objects.add(o);
    }
    if (objects.size === 0) return;
    const fromId = this.componentNode(name, 'Flow');
    for (const o of objects) this.pushObjectRef(fromId, o);
  }

  /** Permission Set / Profile: the objects granted in `<objectPermissions>` → object_metadata_ref. */
  private extractObjectPermissions(): void {
    const name = this.fileName().replace(/\.(permissionset|profile)-meta\.xml$/i, '');
    const label = /\.profile-meta\.xml$/i.test(this.filePath) ? 'Profile' : 'PermissionSet';
    const objects = new Set<string>();
    for (const block of this.source.matchAll(/<objectPermissions>([\s\S]*?)<\/objectPermissions>/gi)) {
      const o = block[1]!.match(/<object>([^<]+)<\/object>/i)?.[1]?.trim();
      if (o) objects.add(o);
    }
    if (objects.size === 0) return;
    const fromId = this.componentNode(name, label);
    for (const o of objects) this.pushObjectRef(fromId, o);
  }

  /** RecordType: object from the path `objects/<Obj>/recordTypes/<Name>.recordType-meta.xml`. */
  private extractRecordType(): void {
    const parts = this.filePath.split(/[/\\]/);
    const rtIdx = parts.lastIndexOf('recordTypes');
    const object = rtIdx >= 1 ? parts[rtIdx - 1] : null;
    if (!object) return;
    const name = this.fileName().replace(/\.recordType-meta\.xml$/i, '');
    const fromId = this.componentNode(name, 'RecordType');
    this.pushObjectRef(fromId, object);
  }
}
