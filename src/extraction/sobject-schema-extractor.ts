import { Node, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * SObjectSchemaExtractor — (viva-local, NEVER upstream) indexes Salesforce
 * SObject FIELDS from their metadata so Apex/SOQL/markup field usages can attach
 * to a real node.
 *
 * A Salesforce DX project stores each field as its own file:
 *   objects/<Object>/fields/<Field>.field-meta.xml
 * with `<fullName>`, `<type>` (Text/Currency/Number/…), and — for formula and
 * lookup fields — `<formula>` / `<referenceTo>`.
 *
 * This emits exactly ONE `sobject_field` node per file, qualifiedName
 * `Object.Field` (the key used for object-disambiguated field resolution). The
 * field's type, whether it's a formula, and any relationship target are stashed
 * in `signature` / `typeParameters` so a later field-impact pass can flag
 * formula fields and resolve `A__r.B__c` relationship paths.
 *
 * The object API name is the field file's grandparent directory (works for both
 * custom `Milestone__c` and standard `Task` objects). One node per field, no
 * edges — code→field edges are emitted by the Apex extractor and linked by the
 * salesforce resolver.
 */
export class SObjectSchemaExtractor {
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
      const node = this.buildFieldNode();
      if (node) {
        this.nodes.push(node);
        this.extractFormulaRefs(node);
      }
    } catch (error) {
      this.errors.push({
        message: `SObject schema extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /**
   * A formula field references other fields on the SAME object — these are the
   * silent breakers when a referenced field changes type or is deleted. Parse
   * the `<formula>` body for `__c` custom-field tokens and emit a
   * field_metadata_ref to each (`@field/Object.Token`); the formula field is the
   * source so field_impact surfaces "referenced by formula <thisField>".
   */
  private extractFormulaRefs(formulaNode: Node): void {
    const formula = this.tag('formula');
    if (!formula) return;
    const object = this.objectApiName();
    if (!object) return;
    const seen = new Set<string>();
    for (const m of formula.matchAll(/\b([A-Za-z_]\w*__c)\b/g)) {
      const token = m[1]!;
      if (token === formulaNode.name || seen.has(token)) continue; // skip self / dupes
      seen.add(token);
      this.unresolvedReferences.push({
        fromNodeId: formulaNode.id,
        referenceName: `@field/${object}.${token}`,
        referenceKind: 'field_metadata_ref',
        line: 1,
        column: 0,
        filePath: this.filePath,
        language: 'apex',
      });
    }
  }

  /** Object API name from `.../objects/<Object>/fields/<Field>.field-meta.xml`. */
  private objectApiName(): string | null {
    const parts = this.filePath.split(/[/\\]/);
    const fieldsIdx = parts.lastIndexOf('fields');
    if (fieldsIdx >= 1) return parts[fieldsIdx - 1] ?? null;
    return null;
  }

  private tag(name: string): string | null {
    const m = this.source.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    return m && m[1] ? m[1].trim() : null;
  }

  private buildFieldNode(): Node | null {
    const objectName = this.objectApiName();
    if (!objectName) return null;
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const fieldName = this.tag('fullName') || fileName.replace(/\.field-meta\.xml$/i, '');
    if (!fieldName) return null;

    const fieldType = this.tag('type'); // Text / Currency / Number / Formula side via <formula>
    const isFormula = /<formula>/i.test(this.source);
    const referenceTo = this.tag('referenceTo'); // lookup/master-detail target object

    // `signature` carries a compact human-readable type used by field_search /
    // field_impact: "Formula(Currency)" | "Lookup:Milestone__c" | "Currency".
    let signature = fieldType || 'Unknown';
    if (isFormula) signature = `Formula(${fieldType || 'Unknown'})`;
    else if (referenceTo) signature = `Lookup:${referenceTo}`;

    const lines = this.source.split('\n');
    return {
      id: generateNodeId(this.filePath, 'sobject_field', `${objectName}.${fieldName}`, 1),
      kind: 'sobject_field',
      name: fieldName,
      qualifiedName: `${objectName}.${fieldName}`,
      filePath: this.filePath,
      language: 'apex',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      signature,
      // referenceTo (relationship target) stashed for P2 A__r.B__c resolution.
      typeParameters: referenceTo ? [referenceTo] : undefined,
      isExported: true,
      updatedAt: Date.now(),
    };
  }
}
