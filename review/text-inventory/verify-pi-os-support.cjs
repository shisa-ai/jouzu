/* Read-only finite native OS/support source verification for pi-os-support.csv, pi-os-support-scope.csv and pi-os-support-boundaries.csv.
 * Usage: node review/text-inventory/verify-pi-os-support.cjs --node-modules <directory>
 *   --cli-node-modules <directory>
 *   --agent-archive <pi-coding-agent.tgz> --tui-archive <pi-tui.tgz>
 * Archive flags are optional; supply both to repeat canonical package provenance checks.
 *   --negative-controls 1 repeats fourteen in-memory rejection checks.
 * Requires the already-installed TypeScript package; performs no installation.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const repo = path.resolve(__dirname, '../..');
const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const nodeModules = path.resolve(flags['node-modules'] || path.join(repo, 'node_modules'));
const cliNodeModules = path.resolve(flags['cli-node-modules'] || path.join(repo, 'packages/cli/node_modules'));
const ts = require(path.join(nodeModules, 'typescript'));
const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function assert(condition, message) { if (!condition) throw new Error(message); }
function csv(source) {
  const records = []; let record = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') { if (quoted && source[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { record.push(value); value = ''; }
    else if (c === '\n' && !quoted) { record.push(value); records.push(record); record = []; value = ''; }
    else value += c;
  }
  assert(!quoted && record.length === 0 && value === '', 'Malformed or unterminated CSV');
  const columns = records.shift();
  return records.map((r) => { assert(r.length === columns.length, 'CSV column count mismatch'); return Object.fromEntries(columns.map((c, i) => [c, r[i]])); });
}
const inventoryDir = path.join(repo, 'review/text-inventory');
const rows = csv(read(path.join(inventoryDir, 'pi-os-support.csv')));
const scopes = csv(read(path.join(inventoryDir, 'pi-os-support-scope.csv')));
const boundaries = csv(read(path.join(inventoryDir, 'pi-os-support-boundaries.csv')));
const exclusionsPath = path.join(inventoryDir, 'pi-os-support-exclusions.csv');
const exclusions = fs.existsSync(exclusionsPath) ? csv(read(exclusionsPath)) : [];
const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-os-support-evidence.json')));
const pin = JSON.parse(read(path.join(repo, 'upstream/pi.lock.json')));
assert(evidence.source_commit === '346d1e481757a55eb62fc066e43bbc7999b8e6dd', 'Immutable product source authority differs');
assert(/^[a-f0-9]{40}$/.test(evidence.unit_source_commit), 'Missing review-unit source commit');
assert(sha(path.join(repo, 'upstream/pi.lock.json')) === evidence.pin.sha256, 'Pi pin snapshot drift');
assert(new Set(rows.map((r) => r.item_id)).size === rows.length, 'Duplicate fixed-text item IDs');
assert(new Set(boundaries.map((r) => r.item_id)).size === boundaries.length, 'Duplicate boundary item IDs');
assert(rows.length === evidence.counts.rows && scopes.length === evidence.counts.scopes, 'Recorded count mismatch');
assert(boundaries.length === evidence.counts.external_boundaries && exclusions.length === evidence.counts.excluded_occurrences, 'Boundary/exclusion count differs from evidence');
assert(evidence.counts.proofs === rows.length, 'Proof count differs from fixed rows');
assert(evidence.counts.catalog_linked_rows === rows.filter((row) => row.message_id).length && evidence.counts.distinct_catalog_ids === new Set(rows.map((row) => row.message_id).filter(Boolean)).size, 'Catalog-link count differs from evidence');
assert(JSON.stringify(evidence.counts.statusCounts) === JSON.stringify(scopes.reduce((counts, row) => { counts[row.status] = (counts[row.status] || 0) + 1; return counts; }, {})), 'Source-status counts differ from evidence');
assert(JSON.stringify(evidence.remaining_partial_sources) === JSON.stringify(scopes.filter((row) => row.status === 'partial').map((row) => row.source)), 'Remaining partial-source list differs from scopes');
const parseLocation = (location) => {
  const owned = /^repo:((?:packages|scripts|upstream|docs)\/[^:]+):(\d+)$/.exec(location);
  if (owned) return { repoSource: true, packageName: 'repo', source: owned[1], line: Number(owned[2]) };
  const match = /^npm:(@earendil-works\/(?:pi-coding-agent|pi-tui))@1\.4\.0\/(.+?)(?::(\d+))?$/.exec(location);
  assert(match, `Invalid npm source notation: ${location}`);
  return { packageName: match[1], source: match[2], line: match[3] ? Number(match[3]) : undefined };
};
const packageVersions = [];
let patchedFiles = 0;
for (const [tree, base] of [['root', nodeModules], ['cli-nested', cliNodeModules]]) {
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
    const root = path.join(base, name), metadata = JSON.parse(read(path.join(root, 'package.json')));
    assert(metadata.name === name && metadata.version === '1.4.0', `Package identity mismatch: ${tree} ${name}`);
    const recorded = evidence.packages.find((p) => p.tree === tree && p.name === name);
    assert(recorded && sha(path.join(root, 'package.json')) === recorded.package_json_sha256, `Package metadata snapshot drift: ${tree} ${name}`);
    packageVersions.push({ tree, name, version: metadata.version });
    for (const deviation of pin.deviations) {
      const manifestPath = path.join(repo, deviation.path);
      assert(sha(manifestPath) === deviation.sha256, `Deviation manifest hash mismatch: ${deviation.path}`);
      const manifest = JSON.parse(read(manifestPath));
      if (manifest.package !== name) continue;
      assert(manifest.version === metadata.version, `Deviation package version mismatch: ${deviation.path}`);
      for (const [source, hashes] of Object.entries(manifest.files || {})) {
        assert(sha(path.join(root, source)) === hashes.after, `Pinned after-hash mismatch: ${tree} ${name}/${source}`);
        patchedFiles++;
      }
    }
  }
}
for (const record of evidence.repo_trace_sources || []) {
  assert(sha(path.join(repo, record.source)) === record.sha256, 'Repo consumer source snapshot drift: ' + record.source);
}
for (const record of evidence.support_sources || []) {
  const parsed = /^npm:(@earendil-works\/[^@]+)@([^/]+)\/(.+)$/.exec(record.source);
  assert(parsed, 'Invalid supplemental source notation: ' + record.source);
  const [, packageName, version, sourcePath] = parsed;
  const rootPath = path.join(nodeModules, packageName, sourcePath), nestedPath = path.join(cliNodeModules, packageName, sourcePath);
  for (const base of [nodeModules, cliNodeModules]) {
    const metadata = JSON.parse(read(path.join(base, packageName, 'package.json')));
    assert(metadata.name === packageName && metadata.version === version, 'Supplemental package identity drift: ' + record.source);
  }
  const rootHash = sha(rootPath), nestedHash = sha(nestedPath);
  assert(rootHash === record.sha256 && nestedHash === record.cli_nested_sha256 && (rootHash === nestedHash) === record.root_nested_equal, 'Supplemental consumer source snapshot drift: ' + record.source);
  const lineCount = read(rootPath).split('\n').length;
  assert(record.read_ranges.every(([start, end]) => start >= 1 && end >= start && end <= lineCount), 'Supplemental source-read range mismatch: ' + record.source);
}


for(const [name,expected]of Object.entries(evidence.reviewed_artifact_sha256))assert(sha(path.join(inventoryDir,name))===expected,'Reviewed data snapshot drift');
const pkg='@earendil-works/pi-coding-agent',base=path.join(nodeModules,pkg,'dist/'),prefix='npm:'+pkg+'@1.4.0/dist/',files=["utils/clipboard.js","utils/clipboard-command.js","utils/clipboard-image.js","utils/open-browser.js","utils/wsl.js","utils/abort.js","utils/fs-watch.js","utils/sleep.js"],hash=b=>crypto.createHash('sha256').update(b).digest('hex'),asts=new Map();
function lexical(file){const body=fs.readFileSync(base+file,'utf8'),ast=ts.createSourceFile(file,body,99,true),nodes=[],regex=[],constructors=[],allNew=[],catches=[],throws=[],imports=[],exports=[],sinks=[];function walk(n){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast)),pos={line:p.line+1,column:p.character+1};if(ts.isStringLiteralLike(n)||ts.isTemplateExpression(n))nodes.push({n,start:n.getStart(ast),end:n.end,...pos,text:ts.isTemplateExpression(n)?n.getText(ast).slice(1,-1):n.text,kind:ts.isTemplateExpression(n)?'template-expression':ts.isNoSubstitutionTemplateLiteral(n)?'no-substitution-template':'string-literal'});if(n.kind===ts.SyntaxKind.RegularExpressionLiteral)regex.push({...pos,source:n.getText(ast)});if(ts.isNewExpression(n))allNew.push({...pos,callee:n.expression.getText(ast),source:n.getText(ast)});if(ts.isNewExpression(n)&&/^(Error|TypeError|RangeError|AggregateError|AggregateException)$/.test(n.expression.getText(ast))){const name=n.expression.getText(ast),index=/^Aggregate/.test(name)?1:0;constructors.push({...pos,constructor:name,message_argument:index,message_expression:n.arguments?.[index]?.getText(ast)||null});}if(ts.isCatchClause(n))catches.push({...pos,source:n.getText(ast)});if(ts.isThrowStatement(n))throws.push({...pos,expression:n.expression.getText(ast)});if(ts.isImportDeclaration(n))imports.push({...pos,specifier:n.moduleSpecifier.text});if(ts.isExportDeclaration(n))exports.push({...pos,specifier:n.moduleSpecifier?.text||null,source:n.getText(ast)});if(ts.isCallExpression(n)&&/^(spawn|spawnSync|execFile|readFileSync|statSync|writeFileSync|rmSync|mkdtempSync|watchFile|watchWithErrorHandler|Compile|validateKeybindingValue.Check|this.getTerminal\(\).setProgramStatus|process.stdout.write|child.on|raceWithAbortSignal|modelRuntime.refresh|Reflect.apply)$/.test(n.expression.getText(ast)))sinks.push({...pos,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});ts.forEachChild(n,walk);}walk(ast);sinks.length=0;function collectCalls(n){if(ts.isCallExpression(n)){const p=ast.getLineAndCharacterOfPosition(n.getStart(ast));sinks.push({line:p.line+1,column:p.character+1,callee:n.expression.getText(ast),arguments:n.arguments.map(a=>a.getText(ast))});}ts.forEachChild(n,collectCalls);}collectCalls(ast);const controls=nodes.filter(n=>n.text.includes('\x1b')||n.text.includes('\\x1b')||n.text.includes('\\u001b')).map(n=>({line:n.line,column:n.column,kind:n.kind,text:n.text}));return{body,ast,nodes,regex,constructors,allNew,catches,throws,imports,exports,sinks,controls};}
for(const f of files)asts.set(f,lexical(f));const loc=(f,l)=>prefix+f+':'+l,anchor=(f,n)=>asts.get(f).body.slice(n.start,Math.min(n.end,n.start+220)).split('\n')[0];
const extraSources=new Map();function source(location){const p=parseLocation(location),key=p.packageName+'/'+p.source;let a=p.packageName===pkg&&p.source.startsWith('dist/')?asts.get(p.source.slice(5)):undefined;if(!a){if(!extraSources.has(key))extraSources.set(key,{body:read(p.repoSource?path.join(repo,p.source):path.join(nodeModules,p.packageName,p.source))});a=extraSources.get(key);}return {...p,...a};}
function verifyFixed(fixed){assert(new Set(fixed.map(r=>r.item_id)).size===fixed.length,'Duplicate fixed ID');for(const p of evidence.proofs){const r=fixed.find(r=>r.item_id===p.item_id);assert(r,'Missing fixed proof occurrence');const s=source(p.source),n=s.nodes.find(n=>n.line===p.line&&n.column===p.column&&n.kind===p.kind);assert(n&&n.text===p.english&&r.english===n.text&&r.english_location===p.source+':'+p.line,'Exact fixed source anchor mismatch');assert(r.evidence===anchor(p.source.slice(prefix.length),n)&&p.evidence===r.evidence,'Fixed evidence prefix mismatch');const target=source(r.display_location);assert(target.line>=1&&target.line<=target.body.split('\n').length,'Display location out of range');assert(r.trigger&&r.consumer_evidence&&r.translation_boundary&&!r.message_id,'Missing route or unproved catalog match');}assert(fixed.every(r=>evidence.proofs.some(p=>p.item_id===r.item_id)),'Fixed row lacks proof');}
verifyFixed(rows);for(const r of boundaries){const s=source(r.source_location);assert(s.body.split('\n')[s.line-1].includes(r.evidence)&&r.trigger&&r.consumer_evidence&&r.translation_boundary,'Boundary source anchor/condition mismatch');}

function verifyPartition(excluded){assert(new Set(excluded.map(r=>r.item_id)).size===excluded.length,'Duplicate exclusion ID');for(const r of excluded){const s=source(r.source_location),n=s.nodes.find(n=>n.line===s.line&&n.column===Number(r.source_column)&&n.kind===r.source_kind);assert(n&&n.text===JSON.parse(r.source_text_json),'Exact exclusion anchor mismatch');assert(r.evidence===anchor(s.source.slice(5),n)&&r.disposition&&r.reason,'Exclusion proof/disposition mismatch');}for(const r of evidence.source_review.files){const s=source(r.source),fx=rows.filter(q=>q.english_location.startsWith(r.source+':')),ex=excluded.filter(q=>q.source_location.startsWith(r.source+':'));for(const n of s.nodes){const e=ex.filter(q=>q.source_location===r.source+':'+n.line&&Number(q.source_column)===n.column),f=evidence.proofs.filter(q=>q.source===r.source&&q.line===n.line&&q.column===n.column);assert(e.length+f.length===1,'Undispositioned or multiply partitioned source occurrence: '+r.source+':'+n.line+':'+n.column);}assert(s.nodes.length===r.string_template_occurrences&&fx.length===r.fixed_rows&&ex.length===r.excluded_occurrences,'Local source-disposition count drift');assert(s.regex.length===r.protected_regex_literals&&hash(JSON.stringify(s.regex))===r.regex_census_sha256,'Protected regex source census drift');assert(JSON.stringify(s.constructors)===JSON.stringify(r.error_constructors),'Error constructor/message builder census drift');assert(JSON.stringify(s.catches)===JSON.stringify(r.catch_clauses),'Catch/suppression census drift');assert(JSON.stringify(s.allNew)===JSON.stringify(r.all_new_expressions)&&JSON.stringify(s.throws)===JSON.stringify(r.throw_statements),'Full constructor/throw census drift');assert(JSON.stringify(s.imports)===JSON.stringify(r.direct_imports)&&JSON.stringify(s.sinks)===JSON.stringify(r.output_or_native_callback_calls),'Raw output/import/callback call census drift');assert(JSON.stringify(s.controls)===JSON.stringify(r.protected_control_occurrences),'Protected terminal control census drift');assert(JSON.stringify(s.exports)===JSON.stringify(r.re_exports),'Re-export source census drift');}}
verifyPartition(exclusions);


const total=(field)=>evidence.source_review.files.reduce((n,r)=>n+(typeof r[field]==='number'?r[field]:r[field].length),0);
assert(evidence.source_review.files.length===8&&evidence.counts.dispositioned_source_files===8&&evidence.counts.string_template_occurrences===154&&rows.length===9&&total('string_template_occurrences')===154&&exclusions.length===145,'Finite eight-body source census drift');
for(const[field,key,n]of[['protected_regex_literals','protected_regex_literals',3],['error_constructors','error_constructors',9],['catch_clauses','catch_clauses',10],['all_new_expressions','all_new_expressions',14],['throw_statements','throw_statements',6],['protected_control_occurrences','protected_control_occurrences',1]])assert(total(field)===n&&evidence.counts[key]===n,'Source structural total drift: '+field);
function verifyLineage(){const l=evidence.public_clipboard_lineage,manifest=JSON.parse(read(path.join(repo,l.manifest))),pinRecord=pin.deviations.find(r=>r.path===l.manifest);assert(pinRecord&&pinRecord.sha256===l.manifest_sha256&&sha(path.join(repo,l.manifest))===l.manifest_sha256&&manifest.files['dist/utils/clipboard.js'].before===l.before_sha256&&manifest.files['dist/utils/clipboard.js'].after===l.after_sha256&&hash(asts.get('utils/clipboard.js').body)===l.after_sha256,'Public clipboard before/after lineage drift');const a=l.addition,repoBytes=fs.readFileSync(path.join(repo,a.repo_source));assert(a.new_full_body_claim===false&&manifest.additions['dist/utils/clipboard-tmux.js'].source==='clipboard-tmux.js'&&manifest.additions['dist/utils/clipboard-tmux.js'].sha256===a.sha256&&hash(repoBytes)===a.sha256,'Parent-owned copied addition provenance differs');for(const base of[nodeModules,cliNodeModules])assert(fs.readFileSync(path.join(base,pkg,'dist/utils/clipboard-tmux.js')).equals(repoBytes),'Installed tmux addition differs from parent source');assert(!evidence.archive_support_sources.some(r=>r.source===a.source)&&!scopes.some(r=>r.source===a.source),'Added helper falsely claimed canonical/new full source');const parentScope=csv(read(path.join(repo,a.parent_scope_source))).find(r=>r.source===a.repo_source);assert(parentScope?.status===a.parent_scope_status&&parentScope.status==='fully-read-copied-bootstrap-unit'&&parentScope.revision===a.parent_scope_revision&&parentScope.revision===evidence.source_commit&&parentScope.sha256===a.sha256,'Parent copied-source full ownership reference differs');const defs=csv(read(path.join(repo,'review/text-inventory/copied-bootstrap.csv'))),owned=defs.filter(r=>r.english_location.startsWith(a.repo_source+':'));assert(owned.length===a.parent_definition_rows&&owned.length===121,'Parent copied-source occurrence membership differs');const cross=l.inserted_error_crosslink,parent=defs.find(r=>r.item_id===cross.parent_item_id),node=rows.find(r=>r.item_id===cross.item_id),ev=JSON.parse(parent.evidence),text=Array.from(read(path.join(repo,ev.path)));assert(parent.item_id==='COPIED-BOOTSTRAP-0319'&&parent.english_location===cross.parent_location&&parent.english===cross.parent_english&&JSON.stringify(ev)===JSON.stringify(cross.parent_evidence)&&ev.kind==='nested-template'&&ev.patch_role[0]==='after'&&ev.guards.some(g=>g.raw==='tmuxEnabled')&&text.slice(ev.start,ev.end).join('')===parent.english&&ev.projected_payload===cross.projected_payload&&node.english===ev.projected_payload,'Inserted clipboard Error parent/source projection differs');const body=repoBytes.toString('utf8');assert(body.includes('accepted: true, confirmed: false')&&!body.includes('confirmed: true')&&body.includes('return { status: "forwarded"'),'Tmux acceptance versus desktop confirmation contract drift');}
function verifySemantics(){const at=(f,line)=>rows.find(r=>r.english_location===prefix+f+':'+line),copy=asts.get('utils/clipboard.js').body;for(const line of[162,164,166,170,173,176])assert(at('utils/clipboard.js',line)?.trigger.includes('copied')&&at('utils/clipboard.js',line).consumer_evidence.includes('returns true after helper resolves or error string after catch')&&at('utils/clipboard.js',line).translation_boundary.includes('not verified desktop clipboard change'),'Clipboard native/API success-display qualification lost');assert(at('utils/clipboard.js',162).trigger.includes('tmuxEnabled===true')&&at('utils/clipboard.js',162).trigger.includes('precedes OSC oversized')&&at('utils/clipboard.js',164).trigger.includes('base64 encoded length>100000')&&at('utils/clipboard.js',164).trigger.includes('Earlier native/backend success returns first'),'Tmux/OSC failure priority condition lost');assert(at('utils/clipboard.js',166).trigger.includes('env.TERMUX_VERSION truthy')&&at('utils/clipboard.js',170).trigger.includes('Wayland hint takes priority even if DISPLAY')&&at('utils/clipboard.js',173).trigger.includes('WAYLAND_DISPLAY falsy')&&at('utils/clipboard.js',176).trigger.includes('no blanket headless generic-failure claim'),'Platform/environment failure branch qualification lost');assert(copy.indexOf('if (copied)\n        return;')<copy.indexOf('if (tmuxEnabled)\n        throw new Error')&&copy.includes('if (!tmuxEnabled && !osc52Emitted && (isRemoteSession(env) || (!copied && headless)))'),'Clipboard source priority/OSC guard proof drift');
const runner=asts.get('utils/clipboard-command.js').body,b=boundaries.find(r=>r.item_id==='pi.os-support.boundary.2');assert(runner.includes('stdio: ["pipe", options?.input === undefined ? "pipe" : "ignore", "ignore"]')&&runner.includes('finish(code === 0 ? Buffer.concat(chunks, length) : undefined)')&&runner.includes('child.on("error", () => finish(undefined))')&&runner.includes('child.stdin?.on("error", () => { })'),'Clipboard child stream/empty success/error event source drift');assert(b.trigger.includes('stderrignore always')&&b.trigger.includes('empty')&&b.translation_boundary.includes('outside guards not closed'),'Captured/ignored child-stream qualification lost');const browser=asts.get('utils/open-browser.js').body;assert(browser.includes('stdio: "ignore", detached: true')&&browser.includes('.on("error", () => { })')&&!browser.includes('shell: true'),'Browser best-effort/native error source proof drift');
const image=asts.get('utils/clipboard-image.js').body,ib=boundaries.find(r=>r.item_id==='pi.os-support.boundary.4');assert(image.includes('if (image === undefined)\n            image = await readClipboardImageViaXclip();')&&image.includes('if (!image && wsl)')&&image.indexOf('const photon = await loadPhoton();')<image.indexOf('const image = photon.PhotonImage.new_from_byteslice(bytes);'),'Image null/undefined/codec pretry source proof drift');assert(ib.trigger.includes('null stops staleX11')&&ib.consumer_evidence.includes('loadPhoton outside conversiontry can reject'),'Image backend/codec suppression qualification lost');
const ar=at('utils/abort.js',4),s7=at('utils/sleep.js',7),s13=at('utils/sleep.js',13);assert(ar.trigger.includes('signal.reason===undefined')&&ar.trigger.includes('Existing reason returned verbatim')&&ar.translation_boundary.includes('no plain TUI/JSON/RPC automatic painting inferred'),'Abort fallback reason gate lost');assert(s7.trigger.includes('signal?.aborted===true before')&&s7.consumer_evidence.includes('catches retry sleep rejection without forwarding Error')&&s13.trigger.includes('while Promise remains pending before timeout resolves')&&s13.trigger.includes('ignored rejection does not publish'),'Sleep native suppression/settlement branch qualification lost');const retry=source('npm:'+pkg+'@1.4.0/dist/core/agent-session.js').body;assert(retry.includes('await sleep(delayMs, this._retryAbortController.signal);\n        }\n        catch {\n            // Aborted during sleep - emit end event so UI can clean up\n            this._finishCancelledRetry();'),'Native retry Error suppression source drift');
const prompt=read(path.join(repo,'packages/session-ui/src/prompt-frame.ts')),extension=read(path.join(repo,'packages/session-ui/src/extension.ts')),interactive=source('npm:'+pkg+'@1.4.0/dist/modes/interactive/interactive-mode.js').body;assert(prompt.includes('class SessionPromptEditor extends CustomEditor')&&prompt.includes('this.keybindingsManager.matches(data, "app.clipboard.pasteImage")')&&extension.includes('ctx.ui.setEditorComponent(')&&interactive.includes('customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();')&&interactive.includes('customEditor.actionHandlers.set(action, handler);'),'Default Jouzu custom-editor native clipboard bridge drift');assert(boundaries.find(r=>r.item_id==='pi.os-support.boundary.3').consumer_evidence.includes('ignores right-click failures'),'Right-click suppression versus keyboard paste failure lost');}
verifyLineage();verifySemantics();
assert(JSON.stringify(evidence.source_review.files.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Full local body membership drift');assert(evidence.source_review.files.every(r=>r.read_lines[0]===1&&r.read_lines[1]===source(r.source).body.split('\n').length),'Whole local body read ranges drift');assert(evidence.counts.full_runtime_lines===567&&evidence.counts.runtime_source_bytes===20454&&files.reduce((a,f)=>a+asts.get(f).body.split('\n').length,0)===567&&files.reduce((a,f)=>a+Buffer.byteLength(asts.get(f).body),0)===20454,'Full body line/byte census drift');
const census=evidence.scope_census;assert(JSON.stringify(scopes.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(census.runtime_files)&&JSON.stringify(census.runtime_files)===JSON.stringify(files.map(f=>'dist/'+f).sort()),'Eight-body finite scope membership drift');for(const r of scopes){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b).toString()===r.root_nested_equal,'Scoped source hash/tree drift');assert(r.status==='source-read-local-producers'&&Number(r.rows)===rows.filter(q=>q.english_location.startsWith(r.source+':')).length,'Finite scope disposition/count drift');}
assert(evidence.nonruntime_assets.length===24&&evidence.counts.nonruntime_assets===24,'Associated nonruntime asset census drift');const expectedAssets=files.flatMap(f=>['.d.ts','.d.ts.map','.js.map'].map(ext=>'dist/'+f.replace('.js',ext))).sort();assert(JSON.stringify(evidence.nonruntime_assets.map(r=>parseLocation(r.source).source).sort())===JSON.stringify(expectedAssets)&&JSON.stringify(census.associated_nonruntime_files)===JSON.stringify(expectedAssets),'Associated declaration/map membership drift');for(const r of evidence.nonruntime_assets){const p=parseLocation(r.source),a=sha(path.join(nodeModules,p.packageName,p.source)),b=sha(path.join(cliNodeModules,p.packageName,p.source));assert(a===r.sha256&&b===r.cli_nested_sha256&&(a===b)===r.root_nested_equal&&r.disposition==='nonruntime-declaration-or-source-map','Nonruntime asset source drift');}
for(const f of ['pi-os-support.csv','pi-os-support-scope.csv','pi-os-support-boundaries.csv','pi-os-support-exclusions.csv','pi-os-support-evidence.json'])assert(!/(?:^|[\s"'(<])[A-Za-z]:[\\/]/m.test(read(path.join(inventoryDir,f)))&&!read(path.join(inventoryDir,f)).includes('\ufffd'),'Private local path or replacement character in inventory');
function tarEntries(archivePath) {
  const tar = zlib.gunzipSync(fs.readFileSync(archivePath)), entries = new Map();
  let offset = 0, extendedPath, longPath;
  const field = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar entry bounds');
    const body = tar.subarray(offset + 512, offset + 512 + size), type = field(header, 156, 1);
    let name = field(header, 0, 100), prefix = field(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    if (type === 'L') longPath = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') {
      let cursor = 0;
      while (cursor < body.length) {
        const space = body.indexOf(32, cursor), length = Number.parseInt(body.subarray(cursor, space).toString('ascii'), 10);
        assert(space > cursor && Number.isSafeInteger(length) && length > 0 && cursor + length <= body.length, 'Invalid PAX record');
        const record = body.subarray(space + 1, cursor + length - 1).toString('utf8');
        if (record.startsWith('path=')) extendedPath = record.slice(5);
        cursor += length;
      }
    } else {
      name = extendedPath || longPath || name; extendedPath = undefined; longPath = undefined;
      if (type === '' || type === '0') {
        assert(!entries.has(name), 'Duplicate archive entry: ' + name);
        entries.set(name, body);
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
function verifyArchiveProvenance() {
  const archiveFlags = [['@earendil-works/pi-coding-agent', flags['agent-archive']], ['@earendil-works/pi-tui', flags['tui-archive']]];
  assert(archiveFlags.every(([, filename]) => filename), 'Supply both --agent-archive and --tui-archive');
  const packageLock = JSON.parse(read(path.join(repo, 'package-lock.json'))), packages = [];
  const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
  for (const [packageName, archivePath] of archiveFlags) {
    const lockRecords = Object.entries(packageLock.packages).filter(([key]) => key.endsWith('node_modules/' + packageName));
    assert(lockRecords.length > 0 && lockRecords.every(([, value]) => value.version === '1.4.0'), 'Missing or inconsistent package lock version: ' + packageName);
    const expected = new Set(lockRecords.map(([, value]) => value.integrity));
    assert(expected.size === 1, 'Inconsistent package lock integrity: ' + packageName);
    const expectedIntegrity = [...expected][0], actualIntegrity = 'sha512-' + digest(fs.readFileSync(archivePath), 'sha512', 'base64');
    assert(actualIntegrity === expectedIntegrity, 'Archive SHA512 differs from package-lock.json: ' + packageName);
    if (pin.packages[packageName]) assert(actualIntegrity === pin.packages[packageName].integrity, 'Archive SHA512 differs from upstream/pi.lock.json: ' + packageName);
    const entries = tarEntries(archivePath), metadataBytes = entries.get('package/package.json');
    assert(metadataBytes, 'Archive lacks package.json: ' + packageName);
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    assert(metadata.name === packageName && metadata.version === '1.4.0', 'Archive package identity mismatch: ' + packageName);
    const patchRecords = pin.deviations.map((deviation) => ({ source: deviation.path, manifest: JSON.parse(read(path.join(repo, deviation.path))) }))
      .filter((record) => record.manifest.package === packageName);
    const scopedFiles = [];
    for (const row of [...scopes, ...evidence.archive_support_sources]) {
      const parsed = parseLocation(row.source);
      if (parsed.packageName !== packageName) continue;
      const archiveBytes = entries.get('package/' + parsed.source);
      assert(archiveBytes, 'Scoped source absent from archive: ' + row.source);
      const archiveSha256 = digest(archiveBytes), rootBytes = fs.readFileSync(path.join(nodeModules, packageName, parsed.source));
      const nestedBytes = fs.readFileSync(path.join(cliNodeModules, packageName, parsed.source));
      const rootSha256 = digest(rootBytes), nestedSha256 = digest(nestedBytes);
      assert(rootBytes.equals(nestedBytes), 'Root/nested scoped bytes differ: ' + row.source);
      let disposition = 'byte-identical-to-archive', deviationManifest;
      if (!archiveBytes.equals(rootBytes)) {
        const permitted = patchRecords.filter((record) => record.manifest.files?.[parsed.source]?.before === archiveSha256 && record.manifest.files[parsed.source].after === rootSha256);
        assert(permitted.length === 1, 'Archive/installed difference lacks one pinned before/after disposition: ' + row.source);
        disposition = 'pinned-source-patch'; deviationManifest = permitted[0].source;
      }
      scopedFiles.push({ source: parsed.source, archive_sha256: archiveSha256, root_sha256: rootSha256,
        cli_nested_sha256: nestedSha256, disposition, ...(deviationManifest ? { deviation_manifest: deviationManifest } : {}) });
    }
    packages.push({ name: packageName, version: metadata.version, archive_integrity: actualIntegrity,
      integrity_authorities: ['package-lock.json', ...(pin.packages[packageName] ? ['upstream/pi.lock.json'] : [])], scoped_files: scopedFiles });
  }
  const result = { packages, scoped_file_count: packages.reduce((n, p) => n + p.scoped_files.length, 0),
    byte_identical_scope_files: packages.reduce((n, p) => n + p.scoped_files.filter((f) => f.disposition === 'byte-identical-to-archive').length, 0),
    pinned_patch_scope_files: packages.reduce((n, p) => n + p.scoped_files.filter((f) => f.disposition === 'pinned-source-patch').length, 0),
    unresolved_scope_differences: 0 };
  assert(result.scoped_file_count === scopes.length + evidence.archive_support_sources.length, 'Archive comparison did not cover every scoped file');
  if (evidence.archive_provenance) assert(JSON.stringify(result) === JSON.stringify(evidence.archive_provenance), 'Archive provenance differs from recorded evidence');
  return result;
}

const archiveProvenance=flags['agent-archive']||flags['tui-archive']?verifyArchiveProvenance():undefined;



function verifyNegativeControls(){assert(archiveProvenance,'Negative controls require both archives');const Module=require('node:module'),code=read(__filename),needle="const evidence = JSON.parse(read(path.join(inventoryDir, 'pi-os-support-evidence.json')));";assert(code.includes(needle),'Negative control anchor missing');const saved=process.argv;process.argv=saved.filter((a,i,all)=>a!=='--negative-controls'&&all[i-1]!=='--negative-controls');const reject=(extra,pattern,label)=>{const child=new Module(__filename,module);child.filename=__filename;try{child._compile(code.replace(needle,()=>needle+'\n'+extra),__filename);}catch(error){assert(pattern.test(error.message),label+': unexpected '+error.message);return label;}throw Error('Negative control accepted: '+label);};try{return [reject("exclusions.pop();evidence.counts.excluded_occurrences--;",/Undispositioned or multiply partitioned source occurrence/,'omitted source occurrence rejected'),reject("rows[0].english+='!';",/Exact fixed source anchor mismatch/,'fixed English corruption rejected'),reject("evidence.repo_trace_sources[0].sha256='0'.repeat(64);",/Repo consumer source snapshot drift/,'consumer source drift rejected'),reject("evidence.archive_provenance.packages[0].scoped_files[0].archive_sha256='0'.repeat(64);",/Archive provenance differs/,'canonical archive corruption rejected'),reject("evidence.public_clipboard_lineage.before_sha256='0'.repeat(64);",/Public clipboard before\/after lineage drift/,'patched clipboard canonical lineage corruption rejected'),reject("evidence.public_clipboard_lineage.addition.new_full_body_claim=true;",/Parent-owned copied addition provenance differs/,'parent copied body duplicate closure rejected'),reject("evidence.public_clipboard_lineage.inserted_error_crosslink.projected_payload+='!';",/Inserted clipboard Error parent\/source projection differs/,'compiled inserted Error source projection drift rejected'),reject("rows.find(r=>r.english_location.endsWith('clipboard.js:164')).trigger='copied true or false: every oversized request including earlier successful copies';",/Tmux\/OSC failure priority condition lost/,'oversize failure priority broadening rejected'),reject("rows[0].translation_boundary='Success proves desktop clipboard changed';",/Clipboard native\/API success-display qualification lost/,'desktop clipboard confirmation claim rejected'),reject("boundaries.find(r=>r.item_id==='pi.os-support.boundary.2').trigger='Child stderr inherited';",/Captured\/ignored child-stream qualification lost/,'child stderr promotion rejected'),reject("boundaries.find(r=>r.item_id==='pi.os-support.boundary.4').trigger='Null always falls through to X11';",/Image backend\/codec suppression qualification lost/,'stale image backend fallback promotion rejected'),reject("rows.find(r=>r.english_location.endsWith('abort.js:4')).trigger='All aborts always use fallback Error';",/Abort fallback reason gate lost/,'existing abort reason overwrite claim rejected'),reject("rows.find(r=>r.english_location.endsWith('sleep.js:13')).trigger='Any abort after timer resolves paints Error';",/Sleep native suppression\/settlement branch qualification lost/,'settled sleep rejection/native paint promotion rejected'),reject("evidence.source_review.files[0].catch_clauses.pop();",/Catch\/suppression census drift/,'clipboard catch omission rejected')];}finally{process.argv=saved;}}
const negativeControls=flags['negative-controls']==='1'?verifyNegativeControls():undefined;
console.log(JSON.stringify({fixed_text_rows:rows.length,external_boundaries:boundaries.length,full_runtime_bodies:8,full_runtime_lines:567,nonruntime_census_assets:24,string_template_occurrences:154,excluded_occurrences:exclusions.length,protected_regex_literals:3,protected_control_occurrences:1,error_constructors:9,catch_clauses:10,archive_provenance:archiveProvenance||'not requested; supply both archive flags',parent_owned_addition:'verified separately; bounded contract only, not canonical/new full closure',negative_controls:negativeControls,patched_after_hash_checks:patchedFiles,scope_status:evidence.counts.statusCounts,remaining_partial_sources:evidence.remaining_partial_sources,exact_source_anchors:'passed; no audited module evaluated',private_local_paths:'absent'},null,2));
