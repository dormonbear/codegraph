import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectory } from '../src/extraction';

let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/**
 * Characterization test for the SObject metadata gitignore-exempt carve-out
 * (mergeSalesforceMetadata). Teams routinely .gitignore `objects/*`; the
 * carve-out must still surface the object/field metadata so the SObject layer
 * isn't empty. Guards the realpathSync removal in the metadata walk: the
 * symlink loop-guard is dead (symlinked dirs are never recursed), so dropping
 * it must not change which files are discovered.
 */
describe('Salesforce metadata catch-up (gitignore-exempt carve-out)', () => {
  it('includes gitignored object/field metadata alongside tracked source', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sfmeta-'));
    fs.writeFileSync(path.join(dir, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app","default":true}]}');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'force-app/main/default/objects/\n');

    const classes = path.join(dir, 'force-app', 'main', 'default', 'classes');
    const acctFields = path.join(dir, 'force-app', 'main', 'default', 'objects', 'Acct__c', 'fields');
    fs.mkdirSync(classes, { recursive: true });
    fs.mkdirSync(acctFields, { recursive: true });
    fs.writeFileSync(path.join(classes, 'A.cls'), 'public class A {}');
    fs.writeFileSync(
      path.join(dir, 'force-app', 'main', 'default', 'objects', 'Acct__c', 'Acct__c.object-meta.xml'),
      '<?xml version="1.0"?><CustomObject xmlns="urn:x"/>'
    );
    fs.writeFileSync(
      path.join(acctFields, 'F__c.field-meta.xml'),
      '<?xml version="1.0"?><CustomField xmlns="urn:x"><type>Text</type></CustomField>'
    );

    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });

    const files = scanDirectory(dir);

    // Tracked source is found via git ls-files.
    expect(files).toContain('force-app/main/default/classes/A.cls');
    // gitignored metadata is added back by the carve-out.
    expect(files).toContain('force-app/main/default/objects/Acct__c/Acct__c.object-meta.xml');
    expect(files).toContain('force-app/main/default/objects/Acct__c/fields/F__c.field-meta.xml');
    // git did NOT track the ignored objects dir.
    const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
    expect(tracked).not.toContain('objects/Acct__c');
  });
});
