import { Node, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * SObjectObjectExtractor — (viva-local, NEVER upstream) indexes Salesforce
 * SObjects (objects) from their metadata so Apex/SOQL/markup OBJECT usages (DML,
 * `FROM Obj`, `List<Obj>`, `trigger on Obj`, `@salesforce/schema/Obj`, VF
 * `standardController`) can attach to a real node — and so object-impact can roll
 * up the object's fields + the declarative metadata that breaks SILENTLY when the
 * object is renamed/retyped/deleted.
 *
 * A Salesforce DX project stores each object as:
 *   objects/<Object>/<Object>.object-meta.xml
 * with `<label>`, optionally `<customSettingsType>` (custom setting) and a name
 * suffix that encodes the kind (`__c` custom, `__mdt` metadata type, `__e`
 * platform event, `__b` big object; no suffix = standard object that the project
 * has customized).
 *
 * Emits exactly ONE `sobject` node per file, qualifiedName `<Object>` (the key
 * used for object-disambiguated resolution). The object's kind is stashed in
 * `signature`. Fields are linked to their parent object as `contains` edges by
 * the salesforce resolver (it sees all nodes; the extractor sees one file).
 */
export class SObjectObjectExtractor {
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
      const node = this.buildObjectNode();
      if (node) this.nodes.push(node);
    } catch (error) {
      this.errors.push({
        message: `SObject object extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /** Object API name from `.../objects/<Object>/<Object>.object-meta.xml`. */
  private objectApiName(): string | null {
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const fromName = fileName.replace(/\.object-meta\.xml$/i, '');
    if (fromName) return fromName;
    // Fallback: the parent directory under objects/.
    const parts = this.filePath.split(/[/\\]/);
    const objectsIdx = parts.lastIndexOf('objects');
    return objectsIdx >= 0 ? parts[objectsIdx + 1] ?? null : null;
  }

  private tag(name: string): string | null {
    const m = this.source.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    return m && m[1] ? m[1].trim() : null;
  }

  /** Compact human-readable kind used by object_search / object_impact. */
  private classify(name: string): string {
    if (/__mdt$/i.test(name)) return 'Custom Metadata Type';
    if (/__e$/i.test(name)) return 'Platform Event';
    if (/__b$/i.test(name)) return 'Big Object';
    if (this.tag('customSettingsType')) return 'Custom Setting';
    if (/__c$/i.test(name)) return 'Custom Object';
    return 'Standard Object';
  }

  private buildObjectNode(): Node | null {
    const name = this.objectApiName();
    if (!name) return null;
    const lines = this.source.split('\n');
    return {
      id: generateNodeId(this.filePath, 'sobject', name, 1),
      kind: 'sobject',
      name,
      qualifiedName: name,
      filePath: this.filePath,
      language: 'apex',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      signature: this.classify(name),
      isExported: true,
      updatedAt: Date.now(),
    };
  }
}
