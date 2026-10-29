"""Inventory a complete compiled component range without running audited UI code."""
import argparse
from collections import Counter
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
UNIT = 'pi-bundle-main-host-ui-components'
SOURCE = 'npm:@earendil-works/pi-coding-agent@1.4.0/dist/bundle/chunks/chunk-MM3LKT73.js'
REL = '@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-MM3LKT73.js'
LOW, HIGH = 3000212, 3070138
FIELDS = ['item_id', 'message_id', 'english', 'english_location', 'display_location',
          'trigger', 'consumer_evidence', 'translation_boundary', 'evidence']
SCOPE_FIELDS = ['source', 'package_version', 'status', 'rows', 'sha256', 'cli_nested_sha256',
                'root_nested_equal', 'review_start_utf16', 'review_end_utf16', 'review_bytes', 'scope_detail']
LIMIT = ('One complete local compiled component range only. Seven components have actual final module exports; '
         'private helpers require the recorded component recipes. Explicit compiled module/API or linked host activation, '
         'successful state construction and actual rendering are required. BASE Jouzu package-dot execution is distinct. '
         'No audited component, theme, callback, terminal, input, file, environment or UI operation runs; '
         'whole main-host, imported renderer/native and wider caller qualifications remain separate.')
PARSER = r'''
const fs=require('node:fs'),input=JSON.parse(fs.readFileSync(0,'utf8')),ts=require(input.typescript);
const text=fs.readFileSync(input.source,'utf8');
const ast=ts.createSourceFile('main.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),low=3000212,high=3070138;
if(ast.parseDiagnostics.length)throw Error('Static parse diagnostics');
const pos=n=>{const start=n.getStart(ast),lc=ast.getLineAndCharacterOfPosition(start);return{start,end:n.end,line:lc.line+1,column:lc.character+1}};
const nodes=[],calls=[],constructors=[],catches=[],throws=[],comments=new Map();
const className=n=>n.name?.getText(ast)??(ts.isVariableDeclaration(n.parent)?n.parent.name.getText(ast):'<anonymous>');
const contains=(outer,inner)=>outer&&inner.getStart(ast)>=outer.getStart(ast)&&inner.end<=outer.end;
const functionOf=n=>{for(let p=n;p;p=p.parent)if(ts.isFunctionLike(p))return p;return null};
const exits=n=>ts.isReturnStatement(n)||ts.isThrowStatement(n)||ts.isBlock(n)&&n.statements.length>0&&exits(n.statements.at(-1));
function walk(n){
 const start=n.getStart(ast),inside=start>=low&&n.end<=high;
 if(inside){
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)||ts.isRegularExpressionLiteral(n)){
   let ownerClass,ownerMethod,ownerFunction,ownerVariable,properties=[],conditions=[],recipeItems=[],nearestCall;
   const fn=functionOf(n),guard=(kind,expression,branch,extra={})=>({kind,condition:expression.getText(ast),branch,phase:functionOf(expression)===fn?'invocation':'enclosing-definition',...pos(expression),...extra});
   for(let p=n.parent;p;p=p.parent){
    if((ts.isClassExpression(p)||ts.isClassDeclaration(p))&&!ownerClass)ownerClass=className(p);
    if(ts.isMethodDeclaration(p)&&!ownerMethod)ownerMethod=p.name.getText(ast);
    if(ts.isFunctionDeclaration(p)&&!ownerFunction)ownerFunction=p.name?.getText(ast);
    if(ts.isVariableDeclaration(p)&&!ownerVariable)ownerVariable=p.name.getText(ast);
    if(ts.isPropertyAssignment(p))properties.push({name:p.name.getText(ast),isKey:p.name===n});
    if(ts.isObjectLiteralExpression(p))for(const field of p.properties)if(ts.isPropertyAssignment(field)&&['id','key','value'].includes(field.name.getText(ast))&&ts.isStringLiteral(field.initializer))recipeItems.push({key:field.name.getText(ast),value:field.initializer.text,...pos(field)});
    if(ts.isIfStatement(p))conditions.push(guard('if',p.expression,contains(p.thenStatement,n)?'then-truthy':contains(p.elseStatement,n)?'else-falsy':'condition-evaluation'));
    if(ts.isConditionalExpression(p))conditions.push(guard('conditional',p.condition,contains(p.whenTrue,n)?'true':contains(p.whenFalse,n)?'false':'condition-evaluation'));
    if(ts.isBinaryExpression(p)&&contains(p.right,n)&&['&&','||','??'].includes(p.operatorToken.getText(ast)))conditions.push(guard('logical-right',p.left,{'&&':'truthy','||':'falsy','??':'nullish'}[p.operatorToken.getText(ast)],{operator:p.operatorToken.getText(ast)}));
    if(ts.isCaseClause(p)||ts.isDefaultClause(p)){
     const clauses=p.parent.clauses,index=clauses.indexOf(p),values=ts.isCaseClause(p)?[p.expression.getText(ast)]:[];
     for(let i=index-1;i>=0&&clauses[i].statements.length===0;i--)if(ts.isCaseClause(clauses[i]))values.unshift(clauses[i].expression.getText(ast));
     conditions.push(guard('switch-case',p.parent.parent.expression,ts.isDefaultClause(p)?'default':'matches-case',{values,defaultExcludedCases:ts.isDefaultClause(p)?clauses.filter(ts.isCaseClause).map(c=>c.expression.getText(ast)):[]}));
    }
    if((ts.isForStatement(p)||ts.isWhileStatement(p))&&p.expression)conditions.push(guard('loop',p.expression,'body'));
    if(ts.isForStatement(p)&&p.condition)conditions.push(guard('loop',p.condition,'body'));
    if(ts.isBlock(p)&&functionOf(p)===fn){
     let statement=n;while(statement.parent&&statement.parent!==p)statement=statement.parent;
     const index=p.statements.indexOf(statement);
     for(let i=0;i<index;i++){const before=p.statements[i];if(ts.isIfStatement(before)&&!before.elseStatement&&exits(before.thenStatement))conditions.push(guard('preceding-exit-guard',before.expression,'must-be-falsy-to-continue'));}
    }
    if((ts.isCallExpression(p)||ts.isNewExpression(p))&&!nearestCall)nearestCall={callee:p.expression.getText(ast),...pos(p),argument:(p.arguments??[]).findIndex(a=>start>=a.getStart(ast)&&n.end<=a.end)};
   }
   const templateParts=ts.isTemplateExpression(n)?[n.head.text,...n.templateSpans.map(s=>s.literal.text)]:null;
   nodes.push({...pos(n),kind:ts.SyntaxKind[n.kind],value:n.text??n.getText(ast),raw:n.getText(ast),templateParts,ownerClass,ownerMethod,ownerFunction,ownerVariable,properties,conditions,recipeItems,nearestCall,parentKind:ts.SyntaxKind[n.parent.kind],parentOperator:ts.isBinaryExpression(n.parent)?n.parent.operatorToken.getText(ast):null});
  }
  if(ts.isCallExpression(n))calls.push({...pos(n),callee:n.expression.getText(ast),raw:n.getText(ast)});
  if(ts.isNewExpression(n))constructors.push({...pos(n),callee:n.expression.getText(ast),raw:n.getText(ast)});
  if(ts.isCatchClause(n))catches.push({...pos(n),raw:n.getText(ast)});
  if(ts.isThrowStatement(n))throws.push({...pos(n),raw:n.getText(ast)});
  for(const r of [...(ts.getLeadingCommentRanges(text,n.pos)||[]),...(ts.getTrailingCommentRanges(text,n.end)||[])])if(r.pos>=low&&r.end<=high)comments.set(r.pos,{start:r.pos,end:r.end,raw:text.slice(r.pos,r.end)});
 }
 ts.forEachChild(n,walk);
}
walk(ast);nodes.sort((a,b)=>a.start-b.start||a.end-b.end);
const exportList=ast.statements.filter(ts.isExportDeclaration).flatMap(n=>n.exportClause?.elements?.map(e=>({name:e.name.getText(ast),local:e.propertyName?.getText(ast)??e.name.getText(ast)}))??[]);
const rendererText=fs.readFileSync(input.rendererSource,'utf8'),rendererAst=ts.createSourceFile('renderer.js',rendererText,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),renderers=[],rendererConstants={};
if(rendererAst.parseDiagnostics.length)throw Error('Renderer parse diagnostics');
function rendererWalk(n){
 if(ts.isVariableDeclaration(n)&&['MIN_DESCRIPTION_WIDTH','PRIMARY_COLUMN_GAP'].includes(n.name.getText(rendererAst))&&ts.isNumericLiteral(n.initializer))rendererConstants[n.name.getText(rendererAst)]=Number(n.initializer.text);
 if(ts.isClassExpression(n)&&ts.isVariableDeclaration(n.parent)&&['SettingsList','SelectList'].includes(n.parent.name.getText(rendererAst)))for(const m of n.members)if(ts.isMethodDeclaration(m)&&['render','renderMainList','renderItem','getVisibleRange','getPrimaryColumnWidth','truncatePrimary'].includes(m.name.getText(rendererAst)))renderers.push({class:n.parent.name.getText(rendererAst),method:m.name.getText(rendererAst),start:m.getStart(rendererAst),end:m.end,raw:m.getText(rendererAst)});
 ts.forEachChild(n,rendererWalk);
}
rendererWalk(rendererAst);
const rendererExports=rendererAst.statements.filter(ts.isExportDeclaration).flatMap(n=>n.exportClause?.elements?.map(e=>({name:e.name.getText(rendererAst),local:e.propertyName?.getText(rendererAst)??e.name.getText(rendererAst)}))??[]);
const rendererImports=ast.statements.filter(ts.isImportDeclaration).flatMap(n=>n.importClause?.namedBindings?.elements?.filter(e=>['SettingsList','SelectList'].includes(e.name.getText(ast))).map(e=>({local:e.name.getText(ast),imported:e.propertyName?.getText(ast)??e.name.getText(ast),module:n.moduleSpecifier.text,raw:n.getText(ast)}))??[]);
process.stdout.write(JSON.stringify({low,high,nodes,calls,constructors,catches,throws,comments:[...comments.values()],exports:exportList,renderers,rendererConstants,rendererExports,rendererImports}));
'''
CONTROLS = {'true', 'false', 'string', 'object', 'function', 'default', 'single', 'automatic', 'light', 'dark',
    'off', 'final', 'streaming', 'all', 'sse', 'websocket', 'websocket-cached', 'auto', 'header', 'tree', 'fork',
    'no-tools', 'user-only', 'labeled-only', 'regular', 'fullscreen', 'transcript', 'resume-hint', 'always', 'hidden',
    'self', 'text', 'image', 'user', 'assistant', 'toolResult', 'bashExecution', 'message', 'custom_message',
    'compaction', 'branch_summary', 'session_info', 'model_change', 'thinking_level_change', 'custom', 'context_edit',
    'label', 'usage', 'stop', 'toolUse', 'aborted', 'left', 'right', 'up', 'down', 'click', 'style'}
UI_VALUES = {'configure', 'save and go back', 'switch to single theme'}
LABEL_MAPS = {'THINKING_DESCRIPTIONS', 'LEVEL_DESCRIPTIONS', 'DEFAULT_PROJECT_TRUST_LABELS'}
PUBLIC = {'SettingsSelectorComponent', 'SkillInvocationMessageComponent', 'ThinkingSelectorComponent',
          'ToolExecutionComponent', 'TreeSelectorComponent', 'UserMessageComponent', 'UserMessageSelectorComponent'}
csv.field_size_limit(64 * 1024 * 1024)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def csv_text(rows, fields):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def classify(node):
    value = node['value']
    static = ''.join(node['templateParts']) if node['templateParts'] is not None else value
    if node.get('ownerMethod') == 'formatToolCall' and node['kind'] == 'TemplateExpression' and re.search('[A-Za-z]', static):
        return True, 'Tool preview caption; protect tool identities and argument fields'
    if node['kind'] == 'RegularExpressionLiteral':
        return False, 'Protected regular-expression/control spelling'
    if not re.search('[A-Za-z]{3}', static):
        return False, 'Decoration, numeric formatting, syntax or dynamic payload; nested prose inventoried separately'
    if any(prop['isKey'] for prop in node['properties']):
        return False, 'Structural property key, not a prose value'
    if node['parentKind'] == 'CaseClause' or node['parentOperator'] in ('===', '!==', '==', '!=', 'in'):
        return False, 'Control comparison or structural membership identity'
    call = node.get('nearestCall') or {}
    callee, argument = call.get('callee', ''), call.get('argument')
    if callee in ('theme.fg', 'theme.bg') and argument == 0:
        return False, 'Theme style identity, not the styled text'
    if callee in ('keyDisplayText', 'keyText') or callee == 'keyHint' and argument == 0 or callee.endswith('.matches') or callee.endswith('.getKeys'):
        return False, 'Keybinding identity; runtime key display remains separately sourced'
    if node.get('ownerFunction') in ('formatHelpKeys', 'compactRawKeys'):
        return False, 'Protected visible keyboard name/abbreviation and formatting mechanism'
    if node.get('ownerMethod') == 'getSearchableText':
        return False, 'Observable search-matching vocabulary/data; preserve recognition coupling without promoting the private helper to public API'
    prop = node['properties'][0]['name'] if node['properties'] else None
    if prop in ('id', 'key', 'keys', 'value') or re.fullmatch('__[A-Za-z0-9_]+__', value):
        return False, 'Option, sentinel, keybinding or control identity'
    if prop in ('values', 'currentValue') and value not in UI_VALUES:
        return False, 'Protected possibly visible option value; localized labels require preserving the control value'
    if node.get('ownerVariable') in LABEL_MAPS:
        return True, 'Thinking-description or project-trust display map'
    if prop in ('label', 'description', 'title'):
        return True, 'UI label, description or title'
    if node.get('ownerFunction') == 'modelThinkingOverridesSummary':
        return True, 'Settings summary caption'
    if value in CONTROLS:
        return False, 'Protocol/mode/role identity; may be visible as raw data under the actual renderer'
    if value in ('none', 'pgup', 'pgdn', 'image/png'):
        return False, 'Technical value, MIME or key-format identity'
    return True, 'Component source caption/prose under the recorded SDK/render recipe'


def recipe(node, minimum_description_width):
    owner, method, variable = node.get('ownerClass'), node.get('ownerMethod'), node.get('ownerVariable')
    prop = node['properties'][0]['name'] if node['properties'] else None
    call = node.get('nearestCall') or {}
    items = ', '.join(item['key'] + '=' + repr(item['value']) for item in node['recipeItems'])
    settings = ('SettingsList main page must be active (no submenu), item must pass its label-only filter. '
        'Labels/current values require the item in [startIndex,endIndex); descriptions are only the selected item description, wrapped at width-4. ')
    select = ('SelectList option must pass the owning submenu/thinking filter and lie in its visible range. '
        'Description additionally requires a truthy single-line description, width>40 and remainingWidth>' + str(minimum_description_width) + '; labels have separate truncation. ')
    if variable == 'THINKING_DESCRIPTIONS':
        return ('SettingsSelector model-thinking submenu, level step: a chosen model must exist; its levels include this map key (' + str(prop) +
            '), from supported reasoning levels or off-only for a nonreasoning model. ' + select)
    if variable == 'LEVEL_DESCRIPTIONS':
        return ('ThinkingSelector availableLevels must include this map key (' + str(prop) + '); default suffix is separately guarded. ' + select)
    if variable == 'DEFAULT_PROJECT_TRUST_LABELS':
        return ('SettingsSelector default-project-trust item uses this label as a raw choice/current value only for the corresponding underlying trust value (' + str(prop) +
            '); row visible and main page active. Inverse lookup derives from the same labels; preserve uniqueness. ')
    if variable == 'TREE_HELP_ITEMS':
        return 'TreeSelector constructs TreeHelp; this label participates in wrapped help even when its keys are unbound. Key formatting is separately protected. '
    if node.get('ownerFunction') == 'modelThinkingOverridesSummary':
        return 'SettingsSelector model-thinking current-value summary, or summary passed back on submenu completion; main row rendering then follows its filter/viewport. '
    if node.get('ownerFunction') in ('themeItems', 'singleModeThemeItems'):
        return 'Theme submenu option list; system-theme description requires its matching name, automatic option is the inserted UI choice. ' + select
    if owner == 'SettingsSelectorComponent':
        if variable == 'steps' and prop in ('title', 'description'):
            return 'Model-thinking wizard activates the corresponding step; SelectSubmenu constructs title/header description from that step, not a selected SettingsList description. Recipe items: ' + items + '. '
        if variable == 'items2':
            return 'Model-thinking wizard option, including the local no-model/clear-override guard. Recipe items: ' + items + '. ' + select
        return 'SettingsSelector constructed successfully; supportsImages aliases TERMINAL getCapabilities().images. Recipe item: ' + items + '. ' + settings
    if owner == 'WarningSettingsSubmenu':
        return 'Settings warnings submenu active with the Anthropic-extra-usage item; bool value identity is protected. ' + settings
    if owner == 'ThemeSubmenu':
        if call.get('callee') == 'this.createThemeSelect':
            return 'Automatic-theme light/dark row submenu activated; createThemeSelect creates a SelectSubmenu title/header description. Recipe item: ' + items + '. '
        if prop in ('label', 'description', 'currentValue', 'values') and variable == 'items':
            return 'Automatic-theme menu active; recipe item: ' + items + '. ' + settings
        return 'Theme submenu current single/automatic page reached; header/title Text is rendered under local mode/callback gates. '
    if owner in ('SelectSubmenu', 'SteppedSubmenu'):
        return 'Selected settings/theme wizard/submenu exists. Header/hints and Step prefix are text components; step prefix requires total>1, search hint follows searchable option. '
    if owner == 'SkillInvocationMessageComponent':
        return 'Exported skill component render/rebuild after expanded/collapsed state selection; fixed ANSI label and collapsed expansion hint are separate from name/body payload. '
    if owner == 'ThinkingSelectorComponent':
        return ('ThinkingSelector constructed with available levels and key map. Option-description/default suffix follows SelectList rules; title and key legends are independent Text components. '
            'Save-as-default legend does not assert its optional callback exists. ' + (select if prop == 'description' else ''))
    if owner == 'ToolExecutionComponent':
        return ('Supported component constructor/updateResult/setExpanded/render path. Caption is from private createResultFallback: definition-backed result fallback chosen, '
            'truthy text, unexpanded output has more than ten lines, remaining>0. Custom renderer success can bypass fallback; errors silently choose fallback, whose own native/serialization failures may preempt it. ')
    if owner == 'TreeList':
        if method == 'getStatusLabels':
            return 'TreeList.render footer for the active TreeSelector body (or supported exposed-list render result), including empty view; exact filter/label-time guards below select the suffix; footer is width-truncated. '
        if method in ('getEntryDisplayText', 'formatToolCall'):
            return ('TreeSelector body/exposed-list render: matching filtered node lies in viewport; usage, empty-assistant, mode/search/folding prefilters apply. '
                'Entry/role/caption branch below must match. formatToolCall also requires mapped prior tool call and matching tool name; native formatting can preempt. These helpers are not promoted as public standalone APIs. ')
        return 'TreeSelector body/exposed-list render; local empty/nonempty and viewport guards apply; label editor can replace body in the ordinary composed view. '
    if owner == 'SearchLine':
        return 'TreeSelector header SearchLine remains even while label input replaces the tree body; query true/false branch below chooses the caption form, then width truncation applies. '
    if owner == 'LabelInput':
        return 'TreeSelector edit-label action has installed LabelInput; caption and save/cancel legend rendered, not proof callback/disk persistence succeeded. '
    if owner == 'TreeSelectorComponent':
        return 'Exported TreeSelector constructor installs the Session Tree header. Empty original tree schedules cancel100ms later; no universal suppression of render/API output is inferred. '
    if owner == 'UserMessageList':
        return 'Exported UserMessageSelector owns this list; empty caption or visible message metadata follows local guards. Metadata/empty caption is not explicitly width-clipped; original empty selector schedules later cancellation. '
    if owner == 'UserMessageSelectorComponent':
        return 'Exported UserMessageSelector constructor installs fork title/header even for a valid empty input array; later cancel100ms and actual caller prevalidation/lifetime remain separate. '
    raise AssertionError('Unreviewed caption recipe: ' + repr((owner, method, variable, prop)))


def generate(modules, nested):
    spec = importlib.util.spec_from_file_location('ui_component_source_proof', HERE / 'verify-pi-package-source-census.py')
    proof = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proof)
    proof_artifacts, universe, _ = proof.generate(modules, nested, ROOT / 'test-results')
    for name, value in proof_artifacts.items():
        assert (HERE / name).read_bytes() == value.encode('utf8'), 'BASE provenance proof stale'
    provenance = next(row for row in universe if row['source'] == SOURCE)
    raw = (modules / REL).read_bytes()
    assert raw == (nested / REL).read_bytes() and sha(raw) == provenance['root_sha256']
    text = raw.decode('ascii')
    renderer_rel = '@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-T726RZZU.js'
    renderer_raw = (modules / renderer_rel).read_bytes()
    renderer_provenance = next(row for row in universe if row['source'] == SOURCE.replace('chunk-MM3LKT73.js', 'chunk-T726RZZU.js'))
    assert sha(renderer_raw) == renderer_provenance['root_sha256'] and renderer_raw == (nested / renderer_rel).read_bytes()
    parsed = json.loads(subprocess.check_output(['node', '-e', PARSER], cwd=ROOT,
        input=json.dumps(dict(typescript=str(modules / 'typescript'), source=str(modules / REL), rendererSource=str(modules / renderer_rel))).encode('utf8')))
    assert {item['local'] for item in parsed['rendererImports']} == {'SettingsList', 'SelectList'}
    for item in parsed['rendererImports']:
        assert item['module'] == './chunk-T726RZZU.js'
        assert any(entry['name'] == item['imported'] and entry['local'] == item['local'] for entry in parsed['rendererExports'])
    renderer_support = {(item['class'], item['method']): item for item in parsed['renderers']}
    assert 'selectedItem?.description' in renderer_support['SettingsList', 'renderMainList']['raw']
    assert 'width>40' in renderer_support['SelectList', 'renderItem']['raw']
    minimum_description_width = parsed['rendererConstants']['MIN_DESCRIPTION_WIDTH']
    contracts = []
    with tarfile.open(ROOT / 'test-results/earendil-works-pi-coding-agent-1.4.0.tgz', 'r:gz') as archive:
        for name in ['tree-selector', 'tool-execution', 'settings-selector']:
            relative = 'dist/modes/interactive/components/' + name + '.d.ts'
            data = archive.extractfile('package/' + relative).read()
            assert data == (modules / '@earendil-works/pi-coding-agent' / relative).read_bytes()
            assert data == (nested / '@earendil-works/pi-coding-agent' / relative).read_bytes()
            contracts.append(dict(source='npm:@earendil-works/pi-coding-agent@1.4.0/' + relative, sha256=sha(data), bytes=len(data),
                boundary='Bounded declaration identity/private-public member qualification only, not whole compiled/unbundled behavior parity.'))
            if name == 'tree-selector':
                assert b'private getSearchableText;' in data and b'getTreeList(): TreeList;' in data
            if name == 'tool-execution':
                assert b'private createResultFallback;' in data
    assert (parsed['low'], parsed['high']) == (LOW, HIGH)
    assert PUBLIC <= {entry['name'] for entry in parsed['exports']}, 'Actual module export capability'
    assert len(parsed['nodes']) == 828 and len(parsed['calls']) == 862 and len(parsed['constructors']) == 98
    assert len(parsed['catches']) == 2 and not parsed['throws']
    frozen = []
    for name in ['pi-bundle-lexical.csv', 'pi-bundle-lexical-regex.csv']:
        frozen.extend(csv.DictReader(io.StringIO((HERE / name).read_bytes().decode('utf8'))))
    frozen = [row for row in frozen if row['source_id'] == 'B023' and LOW <= int(row['start']) and int(row['end']) <= HIGH]
    frozen.sort(key=lambda row: (int(row['start']), int(row['end'])))
    assert len(frozen) == len(parsed['nodes'])
    primary, excluded, partition = [], [], []
    for index, (node, original) in enumerate(zip(parsed['nodes'], frozen)):
        assert (node['start'], node['end'], node['line'], node['column'], node['raw']) == (
            int(original['start']), int(original['end']), int(original['line']), int(original['column']), json.loads(original['raw_source_json']))
        assert text[node['start']:node['end']] == node['raw']
        positive, role = classify(node)
        item_id = UNIT + '.' + str(node['start'])
        location = SOURCE + ':' + str(node['line']) + ':' + str(node['column'])
        frozen_id = original.get('literal_id') or original['regex_id']
        partition.append(dict(frozen_id=frozen_id, index=index, disposition='primary' if positive else 'excluded', role=role, **node))
        if not positive:
            excluded.append(dict(token_id=item_id, source=SOURCE, english_location=location, kind=node['kind'],
                start=node['start'], end=node['end'], source_text_json=compact(node['raw']),
                decoded_text_json=compact(node['value']), reason=role))
            continue
        owner = node.get('ownerClass') or node.get('ownerFunction') or node.get('ownerVariable') or 'component data'
        method = node.get('ownerMethod') or ('constructor' if node.get('ownerClass') else 'definition/helper')
        value = node['value']
        encoding = 'raw-js-template-source' if node['kind'] == 'TemplateExpression' else 'decoded-string'
        if node['kind'] != 'TemplateExpression' and (any(ord(char) < 32 for char in value) or value.rstrip() != value):
            value, encoding = compact(value), 'json-string-cell'
        translation = ('Exact authored string or raw JavaScript template source; template interpolation is not executed/flattened. '
            'Protect ANSI, command/tool names, keybinding/option/control IDs, paths, model/provider/user payloads and formatting. '
            'Visible control values and search vocabulary remain qualified in exclusions/boundaries. Source wording is not a behavior/billing/privacy/platform guarantee.')
        if encoding == 'json-string-cell':
            translation += ' English cell is a JSON string; decode JSON to recover control/trailing characters exactly.'
        consumer = recipe(node, minimum_description_width)
        trigger = (owner + '.' + method + '; ' + consumer + 'Local invocation/definition guards (phase marked): ' + compact(node['conditions']) +
            '. Linked state/helpers must initialize and actual rendering/API result must complete; callbacks, width or native/data failures can preempt it.')
        primary.append(dict(zip(FIELDS, [item_id, '', value, location,
            'Conditional compiled component render/API result then optional TUI paint; exact recipe in this row',
            trigger, consumer, translation, compact(dict(encoding=encoding, role=role, frozen_id=frozen_id, index=index, **node))])))
    assert len(primary) == 189 and len(excluded) == 639
    assert not any(row.get('ownerClass') == 'UserMessageComponent' for row in partition if row['disposition'] == 'primary'), 'User component owns payload transforms, not fixed prose'
    assert next(row for row in partition if row['start'] == 3005169)['disposition'] == 'excluded', 'Clear sentinel role'
    by_start = {node['start']: node for node in partition}
    assert any(guard['kind'] == 'logical-right' and guard['condition'] == 'supportsImages' and guard['branch'] == 'truthy' for guard in by_start[3019371]['conditions'])
    assert any(guard['kind'] == 'switch-case' and guard['condition'] == 'this.filterMode' and guard['values'] == ['"no-tools"'] for guard in by_start[3048216]['conditions'])
    assert any(guard['kind'] == 'switch-case' and guard['condition'] == 'entry.type' and guard['values'] == ['"compaction"'] for guard in by_start[3052633]['conditions'])
    records = [
        ('scope', 'Complete ASCII range[3000212,3070138),69926bytes;828literal/regex/template occurrences joined to frozen B023. Whole main host remains pending.'),
        ('public', 'Seven actual final component exports; constructor/render APIs can expose empty/custom states even where current CLI recipes prevalidate inputs. No private constructor reflection is needed or inferred.'),
        ('selectors', 'SelectSubmenu hardcoded Enter/Esc captions remain distinct from configurable selection key matchers. Step n/N prefix only when total>1; loop/back/cancel and empty option callbacks retain their outcomes. Copy is not proof of working gestures.'),
        ('settings', 'Image-only show-images/image-width rows depend on TERMINAL getCapabilities().images, not model vision. Resize/block/skill/cursor/padding/progress rows have their separate unconditional construction. Actual viewport/selected-item description and width decisions are imported renderer behavior.'),
        ('values', 'Raw bool/mode/transport values can be painted but retain control identities. configure/save-and-go-back/single-theme action words are UI values. Project-trust display labels generate inverse lookup dynamically; preserve distinct labels/bijection.'),
        ('thinking', 'Approximate token-budget descriptions are source UI metadata, not provider-accepted request budgets. Per-model unknown/empty sentinel can lead to empty level choices. Default suffix requires level===defaultThinkingLevel; save-as-default hint is constructed even when optional save callback is absent.'),
        ('theme', 'Automatic versus single menus follow parsed theme setting/current mode. Theme-name/model-name payloads remain dynamic. Preview callbacks are not awaited; callback throws can preempt later transitions. Cancel previews original then calls done(undefined), not proof of persisted rollback.'),
        ('skill', 'Expanded and collapsed ANSI [skill] labels differ; collapsed key hint only when not expanded. Skill name/body Markdown is external data; mouse-left click toggles state. Protect ANSI while handling the label prose.'),
        ('tool-fallback', 'Ten-line cap applies only to truthy result fallback in definition-backed unexpanded rendering. No toolDefinition uses uncapped JSON args/text formatting. Call/result renderer exceptions are silently caught and replaced by fallbacks; fallback serialization/native errors can themselves replace them.'),
        ('tool-images', 'Actual image rows require terminal image capability, showImages, data and MIME. Non-PNG transcode initialization/callback is not native acceptance proof. Self-shell can render zero lines; custom renderer/theme/result payloads remain separately owned.'),
        ('tree-filter', 'Usage is always removed; empty nonleaf nonerror assistant is removed even with filter all. Base setting-entry filters and search/folding add conditions. All/current leaf/active path labels are not a promise that every stored entry paints.'),
        ('tree-text', 'Text preview first200UTF16 before whitespace normalization; error fallback first80UTF16 only without text and after aborted substitution. Copy uses full content/error if its trimmed value is nonempty. These are not global error/output limits.'),
        ('tree-search', 'Private getSearchableText feeds English role/event vocabulary into observable search matching. The exposed list does not promote that private helper into a supported standalone API. These strings retain recognition/data roles; caption translation alone does not localize search aliases. Protected does not mean unobservable.'),
        ('tree-captions', 'Per-entry role/event/label/title captions follow exact type and optional-field branches. Tool preview captions protect actual tool IDs; HOME-prefix shortening is textual, not a path-containment proof. Bash ellipsis tests raw command length; default tool JSON serialization runs twice and can fail or differ.'),
        ('tree-layout', 'Tree body uses horizontal viewport/truncation and selected-row anchor logic; count/status footer also clipped. Help wraps, keeps labels when keys unbound, and protects pgup/pgdn/arrows. Tree header/help/SearchLine stay while label input replaces body.'),
        ('labels', 'Label input trims and maps empty to undefined. In-memory node update occurs before external label callback and hide; callback failure can leave modified view without persistence. External copy/cancel callbacks retain outcomes.'),
        ('user-components', 'UserMessageComponent owns no fixed prose: Markdown text/transformers and role/style/OSC data remain payload/mechanism. User selector empty caption and Message n of N metadata are not explicitly width-clipped by UserMessageList; selected message preview is clipped.'),
        ('empty-lifetime', 'Tree/user selector schedules cancel after100ms when original input list empty. That is not universal first-frame suppression for an exported component API. Current CLI prevalidation, host scheduling, exceptions and disposal require their separate actual caller proof.'),
        ('native-boundary', 'Construction/render/copy/theme/data helpers or callbacks may throw before the caption reaches paint. No malformed-tree/serialization termination, terminal-width behavior, platform support or native clipboard/persistence success is inferred from copy.')]
    boundaries = [dict(boundary_id=UNIT + '.' + key, source=SOURCE, condition=condition, coverage_boundary=LIMIT) for key, condition in records]
    scope = [dict(zip(SCOPE_FIELDS, [SOURCE, '1.4.0', 'partial-source-range-read-local-producers', len(primary), sha(raw), sha(raw), 'true',
        LOW, HIGH, HIGH-LOW, 'Complete component declarations/data/helper range; actual module exports and imported renderer boundaries retained. ' + LIMIT]))]
    outputs = {UNIT + '.csv': csv_text(primary, FIELDS),
        UNIT + '-exclusions.csv': csv_text(excluded, ['token_id', 'source', 'english_location', 'kind', 'start', 'end', 'source_text_json', 'decoded_text_json', 'reason']),
        UNIT + '-boundaries.csv': csv_text(boundaries, ['boundary_id', 'source', 'condition', 'coverage_boundary']),
        UNIT + '-scope.csv': csv_text(scope, SCOPE_FIELDS)}
    evidence = dict(source_revision=BASE, unit=UNIT, counts=dict(partial_ranges=1, bytes=HIGH-LOW, full_body_owners=0,
        primary=189, exclusions=639, lexical=828, frozen_B023_joins=828, calls=862, new_expressions=98, catch_clauses=2,
        throws=0, boundaries=len(boundaries), public_components=sorted(PUBLIC)), source_provenance=provenance,
        coverage_boundary=LIMIT, parser=parsed, lexical_partition=partition, renderer_source_provenance=renderer_provenance, bounded_contracts=contracts,
        primary_by_class=dict(Counter(node.get('ownerClass') or node.get('ownerFunction') or node.get('ownerVariable') or 'data' for node in partition if node['disposition']=='primary')),
        source_proof_sha256=sha((HERE / 'verify-pi-package-source-census.py').read_bytes()),
        source_snapshot_sha256=sha((HERE / 'pi-package-source-census-snapshot.json').read_bytes()),
        verifier_sha256=sha(Path(__file__).read_bytes()), audited_execution=False,
        artifact_sha256={name: sha(value.encode('utf8')) for name, value in outputs.items()})
    outputs[UNIT + '-evidence.json'] = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
    return outputs, evidence


def verify(actual, expected):
    assert actual == expected, 'Exact component source/role/guard inventory differs'


def negative_controls(outputs):
    mutations = [(name, value[:-1]) for name, value in outputs.items()]
    for name, before, after in [
        (UNIT + '.csv', 'No reasoning', 'Always32ktokens'),
        (UNIT + '.csv', 'exact recipe in this row', 'guaranteed ordinary Jouzu paint'),
        (UNIT + '-exclusions.csv', 'recognition coupling', 'never observable'),
        (UNIT + '-boundaries.csv', 'TERMINAL getCapabilities().images', 'MODEL vision capability'),
        (UNIT + '-boundaries.csv', 'only to truthy result fallback', 'to every tool output'),
        (UNIT + '-boundaries.csv', 'not explicitly width-clipped', 'always safely clipped'),
        (UNIT + '-scope.csv', 'partial-source-range-read-local-producers', 'whole-main-host-complete'),
        (UNIT + '-evidence.json', '"audited_execution": false', '"audited_execution": true')]:
        assert before in outputs[name], 'Corruption target absent'
        mutations.append((name, outputs[name].replace(before, after, 1)))
    for name, replacement in mutations:
        changed = dict(outputs)
        changed[name] = replacement
        try:
            verify(changed, outputs)
        except AssertionError:
            continue
        raise AssertionError('Corruption control accepted')
    return len(mutations)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--node-modules', type=Path)
    parser.add_argument('--cli-node-modules', type=Path)
    args = parser.parse_args()
    modules = args.node_modules or next(p / 'node_modules' for p in [ROOT, *ROOT.parents]
        if (p / 'node_modules/@earendil-works/pi-ai/package.json').is_file())
    nested = args.cli_node_modules or modules.parent / 'packages/cli/node_modules'
    outputs, evidence = generate(modules, nested)
    controls = negative_controls(outputs)
    if args.write:
        for name, value in outputs.items():
            (HERE / name).write_text(value, encoding='utf8', newline='\n')
    else:
        verify({name: (HERE / name).read_bytes().decode('utf8') for name in outputs}, outputs)
    print(json.dumps(evidence['counts'] | {'negative_controls': controls, 'audited_execution': False}, indent=2))


if __name__ == '__main__':
    main()
