#!/usr/bin/env python3
"""Read-only source/package/archive verification. Never imports audited JS."""
from pathlib import Path
import argparse,posixpath,base64,copy,csv,hashlib,io,json,re,subprocess,tarfile,functools,collections
csv.field_size_limit(16*1024*1024)
BASE="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
PKG="@earendil-works/pi-coding-agent"
PREFIX="npm:"+PKG+"@1.4.0/"
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent.parent
MOD='dist/bundle/chunks/lib-4AVRLBHM.js'
FILES={MOD:(966765,9,'1ada30d2ddabb60ad5f86e95d7a13d7826ae737a81e8ad2da5efe90994f18c3a')}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
XFIELDS='item_id,source_location,source_column,source_kind,source_text_json,disposition,reason,evidence'.split(',')
BFIELDS='item_id,payload,source_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SFIELDS='source,package_version,status,rows,sha256,cli_nested_sha256,root_nested_equal,scope_detail'.split(',')
PATHS={k:HERE/('pi-bundle-highlight-languages'+suffix) for k,suffix in [('fixed','.csv'),('exclusions','-exclusions.csv'),('boundaries','-boundaries.csv'),('scope','-scope.csv'),('evidence','-evidence.json')]}
def sha(b):return hashlib.sha256(b).hexdigest()
def blob(b):return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
_repo={}
def repo_raw(path):
    if path not in _repo:_repo[path]=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT)
    return _repo[path]
def repo_text(path):return repo_raw(path).decode('utf-8')
def installed_default():return next(p for p in [ROOT,*ROOT.parents] if (p/'node_modules'/PKG/'package.json').is_file())
def lf_lines(b):return b.count(b'\n')+(0 if not b or b.endswith(b'\n') else 1)
class Sources:
    def __init__(self,node_modules=None,cli_node_modules=None,archive=None):
        default=installed_default();self.root=Path(node_modules) if node_modules else default/'node_modules';self.nested=Path(cli_node_modules) if cli_node_modules else default/'packages/cli/node_modules';self.archive_path=Path(archive) if archive else ROOT/'test-results/earendil-works-pi-coding-agent-1.4.0.tgz'
        self.archive_bytes=self.archive_path.read_bytes();self.tar=tarfile.open(fileobj=io.BytesIO(self.archive_bytes),mode='r:gz');self.pin=json.loads(repo_text('upstream/pi.lock.json'));self.original={};self.manifests={}
        for deviation in self.pin['deviations']:
            b=repo_raw(deviation['path']);assert sha(b)==deviation['sha256'];d=json.loads(b)
            if d.get('package')==PKG:
                for rel,h in d.get('files',{}).items():self.manifests[rel]=(deviation['path'],h)
    def bytes(self,rel,tree='root'):return ((self.root if tree=='root' else self.nested)/PKG/rel).read_bytes()
    def text(self,rel):return self.bytes(rel).decode('utf-8')
    def archive(self,rel):
        if rel not in self.original:
            entry=self.tar.getmember('package/'+rel);assert entry.isfile();self.original[rel]=self.tar.extractfile(entry).read()
        return self.original[rel]
    def provenance(self,rel):
        root=self.bytes(rel);nested=self.bytes(rel,'nested');original=self.archive(rel);assert root==nested,(rel,'two installed trees differ')
        if root==original:status='byte-identical-to-canonical-archive';manifest=None
        else:
            manifest,h=self.manifests[rel];assert sha(original)==h['before'] and sha(root)==h['after'];status='pinned-source-patch-after'
        return {'source':PREFIX+rel,'root_sha256':sha(root),'cli_nested_sha256':sha(nested),'archive_sha256':sha(original),'root_nested_equal':True,'provenance':status,'deviation_manifest':manifest,'bytes':len(root),'lines':lf_lines(root)}
    def identities(self):
        result=[]
        for tree,base in [('root',self.root),('cli-nested',self.nested)]:
            b=(base/PKG/'package.json').read_bytes();meta=json.loads(b);assert meta['name']==PKG and meta['version']=='1.4.0';result.append({'tree':tree,'name':meta['name'],'version':meta['version'],'package_json_sha256':sha(b),'exports':meta.get('exports'),'bin':meta.get('bin')})
        pin=self.pin['packages'][PKG];lock=json.loads(repo_text('package-lock.json'))['packages']['node_modules/'+PKG]
        sri='sha512-'+base64.b64encode(hashlib.sha512(self.archive_bytes).digest()).decode();assert sri==pin['integrity']==lock['integrity'];assert pin['version']==lock['version']=='1.4.0'
        return result,{'name':PKG,'version':'1.4.0','archive_name':'earendil-works-pi-coding-agent-1.4.0.tgz','archive_sha256':sha(self.archive_bytes),'archive_integrity':sri,'integrity_authorities':['git:'+BASE+':upstream/pi.lock.json','git:'+BASE+':package-lock.json'],'metadata_qualification':'Installed package.json copies pinned independently; file-level archive/patch provenance checked, not a claim every installed package byte equals pristine archive.'}
@functools.lru_cache(maxsize=8)
def tokens(s):return [x for x in lex(s) if x[2] in ('string','template','regex','hashbang') and x[3]]

@functools.lru_cache(maxsize=8)
def mask(s):
    out=list(s)
    for a,b,k,v in lex(s):
        for i in range(a,b):
            if out[i]!='\n':out[i]=' '
    return ''.join(out)

def matching(s,start):
    stack=[]
    for i in range(start,len(s)):
        c=s[i]
        if c in '([{':stack.append(c)
        elif c in ')]}':
            assert stack and '([{'.index(stack[-1])==')]}'.index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(('unclosed source delimiter',start))

def next_code(code,i):
    while i<len(code) and code[i].isspace():i+=1
    return i

def statement_end(code,i):
    i=next_code(code,i)
    if code[i]=='{':return matching(code,i)+1
    if code.startswith('if',i) and not code[i+2].isalnum():
        a=code.index('(',i);e=matching(code,a);end=statement_end(code,e+1);j=next_code(code,end)
        return statement_end(code,j+4) if code.startswith('else',j) else end
    while i<len(code) and code[i]!=';':
        if code[i] in '([{':i=matching(code,i)
        i+=1
    return min(i+1,len(code))

@functools.lru_cache(maxsize=8)
def regions(s):
    c=mask(s);out=[]
    for m in re.finditer(r'\b(if|for)\s*\(',c):
        a=m.end()-1;b=matching(c,a);start=next_code(c,b+1);end=statement_end(c,start)
        raw=s[a+1:b];out.append((start,end,{'kind':m[1],'line':s.count('\n',0,m.start())+1,'start':a+1,'end':b,'raw':raw,'polarity':'true/body' if m[1]=='if' else 'for-body'}))
        j=next_code(c,end)
        if m[1]=='if' and c.startswith('else',j):
            start=next_code(c,j+4);end=statement_end(c,start);out.append((start,end,{'kind':'if','line':s.count('\n',0,m.start())+1,'start':a+1,'end':b,'raw':raw,'polarity':'false/else'}))
    return out

def guards(s,a,b):return [g for start,end,g in regions(s) if start<=a<b<=end]

def lex(source):
    """Lex JS strings/templates with nested ${...} intact, comments and regexes.

    Templates are recorded as the entire raw source payload. Nested literal
    tokens are also distinct source occurrences; no JavaScript is evaluated.
    """
    out=[];length=len(source)
    def string(i):
        opening=i;quote=source[i];i+=1
        while i<length:
            if source[i]=="\\":i+=2
            elif quote=="`" and source.startswith("${",i):
                start=i;i=code(i+2,True);out.append((start,i,"interpolation",source[start:i]))
            elif source[i]==quote:
                out.append((opening,i+1,"template" if quote=="`" else "string",source[opening+1:i]));return i+1
            else:i+=1
        raise AssertionError((opening,"unterminated JS string/template"))
    def regex(i):
        opening=i;i+=1;inside=False
        while i<length:
            if source[i]=="\\":i+=2;continue
            if source[i]=="[":inside=True
            elif source[i]=="]":inside=False
            elif source[i]=="/" and not inside:
                i+=1
                while i<length and source[i].isalpha():i+=1
                out.append((opening,i,"regex",source[opening:i]));return i
            elif source[i]=="\n":return opening+1
            i+=1
        return opening+1
    def code(i,expression=False):
        depth=1 if expression else 0;previous=""
        while i<length:
            char=source[i]
            if char.isspace():i+=1;continue
            if i==0 and source.startswith('#!',i):
                end=source.find('\n',i);end=length if end<0 else end
                out.append((i,end,'hashbang',source[i:end]));i=end;continue
            if source.startswith("//",i):
                end=source.find("\n",i);end=length if end<0 else end;out.append((i,end,"comment",source[i:end]));i=end;continue
            if source.startswith("/*",i):
                end=source.find("*/",i+2);assert end>=0;end+=2;out.append((i,end,"comment",source[i:end]));i=end;continue
            if char in "\"'`":i=string(i);previous="literal";continue
            if char=="/" and (previous in ("","(","=",":","[",",","!","?","{",";","|","&",">","return","throw","case","=>")):
                end=regex(i)
                if end>i+1:i=end;previous="literal";continue
            if char.isalpha() or char in "_$":
                end=i+1
                while end<length and (source[end].isalnum() or source[end] in "_$"):end+=1
                previous=source[i:end];i=end;continue
            if expression:
                if char=="{":depth+=1
                elif char=="}":
                    depth-=1
                    if depth==0:return i+1
            previous=char;i+=1
        assert not expression,"Unterminated template expression"
        return i
    code(0)
    return sorted(out)
def anchor(ss,raw):
    a=ss.index(raw);return {'start':a,'end':a+len(raw),'raw_source':raw,'line':ss.count('\n',0,a)+1,'column':a-ss.rfind('\n',0,a)}

def primitive_data(ss):
    code=mask(ss);controls=[];catches=[];errors=[];promise_catches=[];finalizers=[]
    for m in re.finditer(r'\b(if|for|while|switch)\s*(?:await\s*)?\(',code):
        a=code.index('(',m.start());b=matching(code,a);controls.append({'kind':m[1],'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\bcatch\s*(?:\([^)]*\))?\s*\{',code):
        a=code.index('{',m.start());b=matching(code,a);catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1],'body_start':a,'body_end':b+1})
    for m in re.finditer(r'\bnew\s+(?:Error|[A-Za-z_$][\w$]*Error)\s*\(|(?<![\w$.])Error\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);errors.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\bfinally\s*\{',code):
        a=code.index('{',m.start());b=matching(code,a);finalizers.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    for m in re.finditer(r'\.catch\s*\(',code):
        a=code.index('(',m.start());b=matching(code,a);promise_catches.append({'start':m.start(),'end':b+1,'raw_source':ss[m.start():b+1]})
    operators=[{'kind':m.group(),'start':m.start(),'end':m.end(),'context_start':max(0,m.start()-60),'context_end':min(len(ss),m.end()+60),'context':ss[max(0,m.start()-60):min(len(ss),m.end()+60)]} for m in re.finditer(r'&&|\|\||\?\?|(?<![?])\?(?![?.])',code)]
    return {'controls':controls,'catches':catches,'error_calls':errors,'promise_catches':promise_catches,'finalizers':finalizers,'shortcircuit_ternary_operators':operators,'qualification':'Source-only control headers and &&/||/??/ternary operator contexts; no path solver or execution. Exact manual trigger states branch polarity and deferred use of definition constants.'}


def js_decode(payload,start):
    """Decode fixed escapes only, with per-character original-source bounds; no evaluation."""
    out=[];mapping=[];i=0
    basic={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','0':'\0'}
    while i<len(payload):
        a=i;c=payload[i];i+=1
        if c=='\\':
            assert i<len(payload);c=payload[i];i+=1
            if c in basic:c=basic[c]
            elif c=='x':c=chr(int(payload[i:i+2],16));i+=2
            elif c=='u':
                if payload[i]=='{':z=payload.index('}',i);c=chr(int(payload[i+1:z],16));i=z+1
                else:c=chr(int(payload[i:i+4],16));i+=4
            elif c=='\n':continue
            elif c=='\r':
                if i<len(payload) and payload[i]=='\n':i+=1
                continue
        out.append(c);mapping.append((start+a,start+i))
    return ''.join(out),mapping

# Full source read in contiguous spans 0..131073; no audited JS was imported.




ROUTE='Internal compiled highlight.js10.7.3 all-language registry. Importing this module calls cached require_lib(), obtains shared core singleton and registers191languages (170local factories plus21imported eager definitions). Compiled terminal module only dynamically imports it inside explicit loadAllHighlightLanguages(); package dot dist/index.js and ordinary Jouzu unbundled graph remain distinct. No audited import/highlight/native operation executed.'
SINK='Local factory metadata, keywords and match scopes are grammar/control identities; they color caller code rather than contribute prose. Single R compiler guard has conditional direct exported core.getLanguage/compilerExtensions API route; ordinary static R grammar lacks conflicting starts. Supporting core compile/highlight and terminal raw-fallback snippets pinned separately; imported bodies not reowned.'
BOUND='Raw English source/templates preserved, technical beforeMatch/starts/language IDs/scope names/keyword spelling/regex/source paths protected. All source literal occurrences partitioned, including large multilingual word tables and nested template literals. Source-defined error occurrence is qualified API/error surface, not active UI or default Jouzu equivalence. No grammar/compiler execution or regex evaluation by audit.'
CORE='dist/bundle/chunks/chunk-5AGIVGSV.js'
TERMINAL='dist/bundle/chunks/chunk-T726RZZU.js'
SHIM='dist/bundle/chunks/chunk-JXWJOIH4.js'
AST_SCRIPT="\n// Parser-only helper. stdin is source data, never imported/evaluated.\nconst fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');\nlet root=process.cwd();while(!fs.existsSync(path.join(root,'node_modules/typescript/package.json'))){if(path.dirname(root)===root)throw Error('Parser unavailable');root=path.dirname(root)}\nconst ts=require(path.join(root,'node_modules/typescript')),text=fs.readFileSync(0,'utf8');\nconst sha=s=>crypto.createHash('sha256').update(s).digest('hex'),ast=ts.createSourceFile('lib-4AVRLBHM.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);if(ast.parseDiagnostics.length)throw Error('Parse error');\nconst literals=[],factories=[],functions=[],callbacks=[],calls=[],news=[],properties=[],statements=[],kinds={};\nconst raw=n=>text.slice(n.getStart(ast),n.end),loc=n=>({start:n.getStart(ast),end:n.end,line:ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1});\nfunction ancestors(n){const props=[],conditions=[];for(let p=n.parent;p;p=p.parent){if(ts.isPropertyAssignment(p))props.push(raw(p.name));if(ts.isIfStatement(p))conditions.push({condition:raw(p.expression),branch:n.getStart(ast)>=p.thenStatement.getStart(ast)&&n.end<=p.thenStatement.end?'then':'else-or-condition'});if(ts.isConditionalExpression(p))conditions.push({condition:raw(p.condition),branch:n.getStart(ast)>=p.whenTrue.getStart(ast)&&n.end<=p.whenTrue.end?'true':n.getStart(ast)>=p.whenFalse.getStart(ast)&&n.end<=p.whenFalse.end?'false':'condition'})}return{properties:props,conditions}}\nfunction walk(n){kinds[ts.SyntaxKind[n.kind]]=(kinds[ts.SyntaxKind[n.kind]]||0)+1;\n if(ts.isStringLiteralLike(n)||ts.isRegularExpressionLiteral(n)||ts.isTemplateExpression(n))literals.push({...loc(n),kind:ts.isRegularExpressionLiteral(n)?'regex':ts.isTemplateExpression(n)||n.kind===ts.SyntaxKind.NoSubstitutionTemplateLiteral?'template':'string',parent:ts.SyntaxKind[n.parent.kind],...ancestors(n)});\n if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text.startsWith('require_')&&n.initializer&&ts.isCallExpression(n.initializer)&&raw(n.initializer.expression)==='__commonJS')factories.push({...loc(n),name:n.name.text,sha256:sha(raw(n)),module_keys:n.initializer.arguments[0].properties.map(p=>raw(p.name))});\n if(ts.isFunctionDeclaration(n))functions.push({...loc(n),name:n.name?.text,sha256:sha(raw(n)),statements:n.body.statements.map(c=>({kind:ts.SyntaxKind[c.kind],...loc(c)}))});\n if(ts.isFunctionExpression(n)||ts.isArrowFunction(n))callbacks.push({...loc(n),raw_source:raw(n),parent:ts.SyntaxKind[n.parent.kind],...ancestors(n)});\n if(ts.isCallExpression(n))calls.push({...loc(n),callee:raw(n.expression),arguments:n.arguments.length});\n if(ts.isNewExpression(n))news.push({...loc(n),callee:raw(n.expression),raw_source:raw(n)});\n if(ts.isPropertyAssignment(n))properties.push({...loc(n),name:raw(n.name),value_kind:ts.SyntaxKind[n.initializer.kind]});\n if(ts.isStatement(n))statements.push({...loc(n),kind:ts.SyntaxKind[n.kind]});\n ts.forEachChild(n,walk);\n}walk(ast);\nconsole.log(JSON.stringify({source_sha256:sha(text),parser:'typescript '+ts.version,parse_errors:0,literals:literals.sort((a,b)=>a.start-b.start),factories,functions,callbacks,calls,news,properties,statements,node_kinds:kinds,top_level:ast.statements.map(n=>({...loc(n),kind:ts.SyntaxKind[n.kind]}))}));\n"
def j(x):return json.dumps(x,ensure_ascii=True,separators=(',',':'))
def csvbytes(rows,fields):
    out=io.StringIO(newline='');w=csv.DictWriter(out,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return out.getvalue().encode()
def jsonbytes(x):return (json.dumps(x,ensure_ascii=True,indent=2)+'\n').encode()
def lineof(s,a):return s.count('\n',0,a)+1
@functools.lru_cache(maxsize=2)
def ast_data(ss):return json.loads(subprocess.check_output(['node','-e',AST_SCRIPT],input=ss.encode(),cwd=ROOT))
def edges_for(path,ss):
    out=[]
    for z in re.finditer(r'''(?:from\s*|import\s*\(\s*)["']([^"']+)["']''',ss):
        if z[1].startswith('.'):out.append({'source':PREFIX+path,'target':posixpath.normpath(posixpath.join(posixpath.dirname(path),z[1])),'start':z.start(),'end':z.end(),'raw_source':z[0]})
    return out
def lf_regressions():
    for separator in ['\x1c','\x1d','\u2028','\u2029']:
        b=('first'+separator+'second\n').encode();assert lf_lines(b)==1 and lineof(b.decode(),len(b.decode()))==2
    assert lf_lines(b'')==0 and lf_lines(b'a')==1
    return 4
def build(sources):
    fixed=[];ex=[];bounds=[];scope=[];primary=[];support=[];provenance=[]
    identities,archive=sources.identities()
    for v in identities:assert v['exports']['.']['import']=='./dist/index.js' and v['bin']['pi']=='dist/bundle/cli.js'
    am=json.loads(sources.archive('package.json'));assert am['exports']['.']['import']=='./dist/index.js' and am['bin']['pi']=='dist/bundle/cli.js'
    ss=sources.text(MOD);p=sources.provenance(MOD);size,lines,h=FILES[MOD];assert p['provenance']=='byte-identical-to-canonical-archive' and p['bytes']==size and p['lines']==lines and p['root_sha256']==sha(ss.encode())==h;provenance.append(p);assert lf_regressions()==4
    nodes=[x for x in lex(ss) if x[2] in ('string','template','regex','hashbang')];pd=primitive_data(ss);ast=ast_data(ss);assert ast['source_sha256']==h and ast['parse_errors']==0
    assert [(a,b,k) for a,b,k,v in nodes]==[(r['start'],r['end'],r['kind']) for r in ast['literals']], 'Independent TypeScript AST/Python lexical partition'
    assert len(ast['factories'])==171 and len(ast['functions'])==258 and len(ast['callbacks'])==70 and len(ast['calls'])==1251
    assert len(ast['news'])==3 and [r['callee'] for r in ast['news']]==['RegExp','Set','Error']
    assert len(pd['controls'])==2 and len(pd['error_calls'])==1 and not pd['catches'] and not pd['promise_catches'] and not pd['finalizers']
    assert all(r['kind'] in ['ImportDeclaration','FirstStatement','ExportAssignment'] for r in ast['top_level'])
    assert all(r['kind'] not in ['TryStatement','WhileStatement','ForStatement','ForOfStatement','ForInStatement','SwitchStatement','AwaitExpression'] for r in ast['statements'])
    factories=ast['factories'];assert factories[0]['start']==498 and factories[-1]['name']=='require_lib' and factories[-1]['end']==966734
    node_map={r['start']:r for r in ast['literals']};factory_nodes=collections.Counter();language_names=[]
    for a,b,k,v in nodes:
        owners=[r for r in factories if r['start']<=a<b<=r['end']];assert len(owners)<=1
        owner=owners[0]['name'] if owners else '<module import/export>';factory_nodes[owner]+=1;ar=node_map[a]
        ev={'path':MOD,'start':a,'end':b,'kind':k,'payload':v,'raw_source':ss[a:b],'line':lineof(ss,a),'column':a-ss.rfind('\n',0,a),'if_for_guards':guards(ss,a,b),'ast_properties':ar['properties'],'ast_conditions':ar['conditions'],'factory':owner,'context':ss[max(0,a-100):min(len(ss),b+90)]};loc=PREFIX+MOD+':'+str(ev['line'])
        if a==776198:
            assert v=='beforeMatch cannot be used with starts' and owner=='require_r'
            item='pi.bundle-highlight-languages.fixed.1';reason='R returned grammar compilerExtensions callback: mode.beforeMatch truthy AND mode.starts truthy throws. Checked-in number mode has beforeMatch but no starts, so ordinary unmodified grammar/input does not establish this diagnostic. Default exported hljs.getLanguage(r) returns mutable grammar and callback array: direct callback invocation with conflicting custom mode OR custom grammar mutation before compile gives API-only route. Core compileMode invokes extensions before mode.isCompiled and outside _highlight parsing try/catch; direct highlight API may throw, terminal highlightCode catches ->raw lines and Markdown callback catches ->themed raw lines. No current normal UI activation inferred.'
            fixed.append(dict(zip(FIELDS,[item,'',v,loc,'Conditional direct core/compiler-extension API exception; ordinary terminal consumers replace with raw-code fallback.',reason+' '+ROUTE,SINK,BOUND,j(ev)])));primary.append({'item_id':item,**ev})
        else:
            if k=='regex':disp='protected-grammar-regex';reason='Language matching/illegal/scope lexical regex source; never own diagnostic/prose and not translated.'
            elif k=='template':disp='protected-grammar-source-format';reason='Regex construction, keyword relevance score or matching delimiters; nested source literals remain independently partitioned. Not prose or evaluated by audit.'
            elif 'name' in ar['properties'] or 'aliases' in ar['properties'] or owner=='require_lib':
                disp='protected-language-module-identity';reason='Language display/name/alias/registry/module identity is compiler/API data. Direct metadata enumeration may expose identity to caller; no local UI or translation ownership inferred.'
                if 'name' in ar['properties']:language_names.append({'start':a,'raw_source':ss[a:b],'factory':owner})
            else:disp='protected-grammar-keyword-scope-or-data';reason='Technical keyword/builtin/type/literal/operator/comment/word table/scope/sublanguage/grammar/source/match delimiter. English-looking words including Error/console/status/help/command tokens are language input matches, not emitted diagnostics. All exact values/context retained; table data structurally reviewed, not runtime prose.'
            ex.append(dict(zip(XFIELDS,['pi.bundle-highlight-languages.excluded.'+str(len(ex)+1),loc,ev['column'],k,j(v),disp,reason,j(ev)])))
    assert len(fixed)==1 and len(ex)==16091 and sum(factory_nodes.values())==16092
    def boundary(a,b,kind,reason):bounds.append(dict(zip(BFIELDS,['pi.bundle-highlight-languages.boundary.'+str(len(bounds)+1),kind,PREFIX+MOD+':'+str(lineof(ss,a)),'Conditional grammar API/compiler or caller code projection',reason,SINK,BOUND,j({'path':MOD,'start':a,'end':b,'raw_source':ss[a:b]})])))
    for f in factories:
        isregistry=f['name']=='require_lib';reason=('Registry callback obtains shared core and calls registerLanguage191times then exports singleton. Imports21 eager language factories from core chunk, local170 definitions initialized lazily by cached CommonJS wrappers. Registration calls grammar functions, not source-code evaluation. Registration may console/error through imported core catch on factory failure, safeMode may install plaintext else rethrow; native/intrinsic/SDK failures dynamic, not local authored prose.' if isregistry else 'Complete local grammar factory wrapper body structurally reviewed: declarations/matching modes/keyword tables/aliases/names/contains/starts/sublanguage/illegal/relevance and helper transforms. No local console/UI/file/process output. Values color caller source and grammar API data, not fixed prose. Core-supplied helper/compiler/parser/native RegExp failures separately owned. All embedded callbacks and operational calls partitioned, not a hash-only review.')
        boundary(f['start'],f['start']+len(f['name']),'Full factory data/control disposition',reason)
    for cb in ast['callbacks']:
        reason=('R compiler-extension callback: beforeMatch absent returns; conflicting starts throws own API guard; otherwise copy mode, delete own keys, create beforeMatch lookahead wrapper/starts child and remove original beforeMatch.' if cb['start']==776123 else 'R rewrite Object.keys(mode).forEach deletes each copied mode key; structural mutation, no own text.' if cb['start']==776306 else 'Mathematica on:begin match callback checks SYSTEM_SYMBOLS_SET.has(match[0]); if absent response.ignoreMatch(), no authored prose or own diagnostic.' if cb['start']==650650 else 'Complete regex/string/list/keyword-relevance/mode-construction callback. Returns grammar data or transforms local pattern lists; no local console/async/network handler or own authored prose. Native getters/intrinsic/imported helper errors can escape; no local catch.')
        boundary(cb['start'],cb['end'],'Full callback/control disposition',reason)
    for n in ast['news']:boundary(n['start'],n['end'],'Native constructor/error boundary','LaTex grammar fixed RegExp construction OR Mathematica Set table OR R explicit compiler Error. Native allocation/pattern failures dynamic; no constructor invoked by audit.')
    def supportspan(path,needle,claim):support.append({'source':PREFIX+path,**anchor(sources.text(path),needle),'claim':claim,'coverage':'bounded exact support, prior full owner separate'})
    core=sources.text(CORE)
    for needle,claim in [('function getLanguage(name){return name=(name||"").toLowerCase(),languages[name]||languages[aliases[name]]}','Actual returned grammar object; no cloning/freeze here. Direct getLanguage API mutable callback access qualifies R conflict diagnostic without claiming ordinary static grammar reaches guard.'),('language.compilerExtensions.forEach(ext=>ext(mode,parent))','Core compiler invokes extension callbacks before isCompiled assignment. Full core prior pi-bundle-highlight-core owner, no duplicate full coverage.'),('let md=compileLanguage(language,{plugins})','Compilation before _highlight later parse try/catch; direct API compiler exceptions escape parse safe fallback. Core API/body prior owner distinct.'),('try{lang=languageDefinition(hljs)}catch(error$1)','Registry factory failures enter core registration catch: fixed core own diagnostic prior owner, original dynamic reason dependent safe/debug mode.'),('Object.assign(hljs,{highlight:highlight2,highlightAuto,highlightAll,fixMarkup:deprecateFixMarkup,highlightElement,highlightBlock:deprecateHighlightBlock,configure,initHighlighting,initHighlightingOnLoad,registerLanguage,unregisterLanguage,listLanguages,getLanguage,registerAliases,requireLanguage,autoDetection,inherit:inherit$1,addPlugin,vuePlugin:BuildVuePlugin(hljs).VuePlugin})','Exported core method access, not private unreachable callback.' )]:supportspan(CORE,needle,claim)
    term=sources.text(TERMINAL)
    for needle,claim in [('function loadAllHighlightLanguages(){','Exported explicit deferred loader; module import alone does not call function.'),('import("./lib-4AVRLBHM.js").then(()=>resolve(),()=>{resolve()})','Lazy module import rejection swallowed into resolved cached Promise; native import source/errors distinct.'),('try{return highlight(code,opts).split(`\n`)}catch{return code.split(`\n`)}','Terminal highlightCode compiler/parse errors replaced by raw-code lines.'),('catch{return code.split(`\n`).map(line=>theme.fg("mdCodeBlock",line))}','Markdown highlighter compiler/parse failures ->themed raw lines; theme callback can replace.')]:supportspan(TERMINAL,needle,claim)
    edges=edges_for(MOD,ss);reverse=[x for x in edges_for(TERMINAL,term) if x['target']==MOD]
    registrations=[]
    for c in ast['calls']:
        if c['callee']=='hljs.registerLanguage':registrations.append({'start':c['start'],'end':c['end'],'raw_source':ss[c['start']:c['end']]})
    assert len(registrations)==191
    fproof=[]
    for f in factories:fproof.append({**f,'literal_occurrences':factory_nodes[f['name']],'role':'registry' if f['name']=='require_lib' else 'language grammar data factory','coverage':'Full structural mode/keyword/pattern/control review; all literals partitioned, no prose inferred from tables.'})
    scope.append(dict(zip(SFIELDS,[PREFIX+MOD,'1.4.0','source-read-local-producers',len(fixed),h,p['cli_nested_sha256'],'true',f'Full {lines}physical LF lines/{size}bytes;16092nodes=1API-only primary+16091protected exclusions;171CommonJS wrappers/170local grammars+registry;258functions/70callbacks/191registrations reviewed with complete independent AST partition. Static grammar data structurally reviewed as data, not prose; no prior full semantic owner. '+ROUTE])))
    for path in [CORE,SHIM,TERMINAL]:
        p=sources.provenance(path);provenance.append(p);spans=[{'start':x['start'],'end':x['end']} for x in support if x['source']==PREFIX+path];scope.append(dict(zip(SFIELDS,[PREFIX+path,'1.4.0','partial' if spans else 'bundle-dependency-hash-only',0,p['root_sha256'],p['cli_nested_sha256'],'true','Bounded exact spans '+j(spans)+'; prior semantic owners remain separate, no full ownership.' if spans else 'CommonJS structural helper dependency hash/archive/two-tree only; no full imported semantics promoted.'])))
    repo=[]
    for path in ['upstream/pi.lock.json','package-lock.json','packages/cli/src/main-cli.ts']:
        b=repo_raw(path);repo.append({'source':'git:'+BASE+':'+path,'sha256':sha(b),'git_blob_sha1':blob(b),'coverage':'pin/root import only'});scope.append(dict(zip(SFIELDS,['git:'+BASE+':'+path,'repo','repo-bounded-consumer-or-pin',0,sha(b),'','false','BASE immutable pin/root unbundled import only; no full body ownership.'])))
    counts={'full_bodies':1,'full_bytes':size,'physical_lf_lines':lines,'ast_line_starts':ss.count('\n')+1,'root_nodes':len(nodes),'primary':len(fixed),'exclusions':len(ex),'boundaries':len(bounds),'scopes':len(scope),'commonjs_wrappers':len(factories),'local_language_factories':len(factories)-1,'registrations':len(registrations),'named_functions':len(ast['functions']),'callbacks':len(ast['callbacks']),'calls':len(ast['calls']),'native_constructors':len(ast['news']),'if_guards':len(pd['controls']),'catches':0,'promise_catches':0,'finalizers':0,'direct_import_edges':len(edges),'bounded_reverse_import_edges':len(reverse),'jouzu_catalog_ids':0,'lf_count_regressions':4}
    evidence={'schema':'pi-bundle-highlight-languages-v1','source_revision':BASE,'package_identities':identities,'archive_provenance':archive,'source_provenance':provenance,'primary_proofs':primary,'source_review':{'source':PREFIX+MOD,'full_body_review':True,'review_method':'Complete independent AST/literal partition and per-factory structural grammar/data review; all operation call targets, helper/control bodies and callbacks reviewed. Large multilingual keyword/numeric/regex/table values retained exactly as protected source; not interpreted as authored prose. Sole authored error API guard source/triggers individually traced. No hash-only semantic promotion.','primitives':pd,'factories':fproof,'independent_ast':ast,'language_name_occurrences':language_names,'comments':[{'start':a,'end':b,'raw_source':v,'disposition':'developer/source only'} for a,b,k,v in lex(ss) if k=='comment'],'export':anchor(ss,'export default require_lib();')},'bounded_support_excerpts':support,'repo_trace_sources':repo,'direct_import_edges':edges,'bounded_reverse_import_edges':reverse,'registration_calls':registrations,'counts':counts,'limits':[ROUTE,SINK,BOUND,'Static R number mode beforeMatch has no starts. Own diagnostic only direct callback/custom mutable grammar API qualified; arbitrary intrinsic mutation external, no supported ordinary source-input route asserted.','No model/code/grammar/API operations executed; TypeScript parser sees source as stdin data only. Language metadata/word tables and highlighted caller code not new translation targets. Other imported/compiled/unbundled graphs remain separately scoped.']}
    return {'fixed':csvbytes(fixed,FIELDS),'exclusions':csvbytes(ex,XFIELDS),'boundaries':csvbytes(bounds,BFIELDS),'scope':csvbytes(scope,SFIELDS),'evidence':jsonbytes(evidence)},evidence

def validate(actual,expected):
    assert actual.keys()==expected.keys()
    for key,b in actual.items():
        assert not b.startswith(b'\xef\xbb\xbf') and b'\r' not in b,(key,'UTF8/LF')
        b.decode('utf-8');assert b==expected[key],(key,'source-derived bytes differ')

def negatives(expected,sources):
    passed=[]
    def reject(name,change):
        bad=dict(expected);change(bad)
        try:validate(bad,expected)
        except (AssertionError,UnicodeDecodeError):passed.append(name);return
        raise AssertionError(('corruption accepted',name))
    for key in expected:
        reject(key+'-delete-byte',lambda b,k=key:b.__setitem__(k,b[k][:-1]))
        reject(key+'-CRLF',lambda b,k=key:b.__setitem__(k,b[k].replace(b'\n',b'\r\n')))
        reject(key+'-BOM',lambda b,k=key:b.__setitem__(k,b'\xef\xbb\xbf'+b[k]))
    for key,col in [('fixed','english'),('fixed','trigger'),('fixed','english_location'),('exclusions','disposition'),('boundaries','trigger'),('scope','scope_detail')]:
        def mutate(b,k=key,c=col):
            rows=list(csv.DictReader(io.StringIO(b[k].decode())));rows[0][c]='corrupt';b[k]=csvbytes(rows,list(rows[0]))
        reject(key+'-'+col,mutate)
    class Mutated:
        def __init__(self,path,old,new):self.path=path;self.old=old;self.new=new
        def __getattr__(self,k):return getattr(sources,k)
        def text(self,path):
            t=sources.text(path);return t.replace(self.old,self.new,1) if path==self.path else t
    for name,path,old,new in [('r-beforeMatch',MOD,'if(!mode.beforeMatch)','if(mode.beforeMatch)'),('r-starts',MOD,'if(mode.starts)','if(!mode.starts)'),('registry-r',MOD,'hljs.registerLanguage("r",require_r())','hljs.registerLanguage("z",require_r())')]:
        assert old in sources.text(path)
        try:build(Mutated(path,old,new))
        except AssertionError:passed.append(name);continue
        raise AssertionError(('source mutation accepted',name))
    class BrokenProvenance:
        def __init__(self,field):self.field=field
        def __getattr__(self,k):return getattr(sources,k)
        def provenance(self,path):
            v=copy.deepcopy(sources.provenance(path));v[self.field]='corrupt';return v
    for field in ['root_sha256','provenance','bytes','lines']:
        try:build(BrokenProvenance(field))
        except AssertionError:passed.append('provenance-'+field);continue
        raise AssertionError(('bad provenance accepted',field))
    class WrongExports:
        def __getattr__(self,k):return getattr(sources,k)
        def identities(self):
            identities,archive=sources.identities();identities[0]['exports']['.']['import']='./dist/bundle/index.js';return identities,archive
    try:build(WrongExports())
    except AssertionError:passed.append('wrong-root-export')
    else:raise AssertionError('wrong root export accepted')
    class ChangedNested(Sources):
        def __init__(self):self.__dict__=sources.__dict__.copy()
        def bytes(self,rel,tree='root'):
            b=super().bytes(rel,tree);return b'!'+b[1:] if rel==MOD and tree=='nested' else b
    try:build(ChangedNested())
    except AssertionError:passed.append('two-tree-disagreement')
    else:raise AssertionError('tree disagreement accepted')
    class ChangedArchive(Sources):
        def __init__(self):self.__dict__=sources.__dict__.copy();self.archive_bytes=b'!'+sources.archive_bytes[1:]
    try:build(ChangedArchive())
    except AssertionError:passed.append('archive-SRI-disagreement')
    else:raise AssertionError('archive SRI disagreement accepted')
    return passed

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--node-modules');ap.add_argument('--cli-node-modules');ap.add_argument('--archive');args=ap.parse_args();s=Sources(args.node_modules,args.cli_node_modules,args.archive)
    expected,data=build(s);validate({k:p.read_bytes() for k,p in PATHS.items()},expected);controls=negatives(expected,s);print('PASS '+j(data['counts'])+'; rejection_controls='+str(len(controls)))
if __name__=='__main__':main()
