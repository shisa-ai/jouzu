"""Read-only CLI parser/catalog/status source inventory; no product/runtime execution."""
import csv,hashlib,json,re
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
FILES=['packages/cli/src/args.ts','packages/cli/src/catalog-command.ts','packages/cli/src/locale-status.ts']
@cache
def read(path):return (ROOT/path).read_text(encoding='utf-8')


@cache
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


@cache
def code_mask(path):
    source=read(path);result=list(source)
    for a,b,k,t in lex(source):
        for i in range(a,b):
            if result[i]!='\n':result[i]=' '
    return ''.join(result)


@cache
def matching(code,start):
    stack=[]
    for i in range(start,len(code)):
        c=code[i]
        if c in '([{':stack.append(c)
        elif c in ')]}':
            assert stack and '([{'.index(stack[-1])==')]}'.index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(('unclosed',start))


@cache
def regions(path):
    source=read(path);code=code_mask(path);out=[]
    for match in re.finditer(r'\b(if|for|catch)\s*\(',code):
        opening=match.end()-1;close=matching(code,opening);body=close+1
        while body<len(code) and code[body].isspace():body+=1
        if code[body:body+1]=='{':end=matching(code,body)+1
        else:
            # Single statement, with all nested delimiters skipped.
            end=body
            while end<len(code) and code[end]!=';':
                if code[end] in '([{':end=matching(code,end)
                end+=1
            end+=1
        out.append((body,end,match[1],opening+1,close,match.start()))
    for match in re.finditer(r'\bfunction\s+(\w+)\s*\(',code):
        close=matching(code,match.end()-1);body=code.find('{',close)
        assert body>=0
        out.append((body,matching(code,body)+1,'function',match.start(),close+1,match.start()))
    return out


@cache
def guard_evidence(path,a,b):
    return [{'kind':k,'start':x,'end':y,'line':read(path).count('\n',0,x)+1,'raw':read(path)[x:y]}
            for start,end,k,x,y,z in regions(path) if start<=a<b<=end]


@cache
def tokens(path):return [(a,b,k,t) for a,b,k,t in lex(read(path)) if k in ('string','template','regex','hashbang') and t]


@cache
def symbol_ids(owner):
    path='packages/cli/src/human-messages.ts' if owner=='CliMessageId' else 'packages/cli/src/cli-messages.ts'
    text=read(path);a=text.index('export const '+owner+' = {');b=text.index('} as const',a)
    return {m[1]:m[2] for m in re.finditer(r'^\s*(\w+):\s*"(jouzu\.[^"]+)"',text[a:b],re.M)}


@cache
def field_ids():
    text=read('packages/cli/src/cli-messages.ts');a=text.index('export const CATALOG_FIELD_LABEL_IDS:');b=text.index('});',a)
    return {(m[1] or m[2]):m[3] for m in re.finditer(r'^\s*(?:"([^"]+)"|(\w+)):\s*"(jouzu\.[^"]+)"',text[a:b],re.M)}


@cache
def references(path):
    text=read(path);code=code_mask(path);out=[]
    for m in re.finditer(r'\b(CliMessageId|CatalogMessageId)\.(\w+)',code):
        out.append(dict(start=m.start(),end=m.end(),kind='catalog-reference',owner=m[1],symbol=m[2],message_id=symbol_ids(m[1])[m[2]],guards=guard_evidence(path,m.start(),m.end())))
    if path.endswith('/catalog-command.ts'):
        for a,b,k,t in tokens(path):
            if k=='string' and re.search(r'\blabel\(\s*$',text[:a]):
                assert t in field_ids()
                out.append(dict(start=a+1,end=b-1,kind='field-label-catalog-reference',owner='CATALOG_FIELD_LABEL_IDS',symbol=t,message_id=field_ids()[t],guards=guard_evidence(path,a,b)))
    return sorted(out,key=lambda n:(n['start'],n['end'],n['kind']))


@cache
def catalog_rows():
    with (HERE/'catalogs.csv').open(encoding='utf-8',newline='') as file:return {r['message_id']:r for r in csv.DictReader(file)}


@cache
def catalog_definition(mid):
    row=catalog_rows()[mid];path,number=row['english_location'].rsplit(':',1);number=int(number)
    text=read(path);lines=text.splitlines(keepends=True);offset=sum(map(len,lines[:number-1]));line=lines[number-1].rstrip('\r\n')
    match=re.match(re.escape(row['fluent_id'])+r'\s*= ?(.*)',line);assert match,(mid,line)
    a=offset+match.start(1);b=offset+match.end(1);i=number
    while i<len(lines) and lines[i].strip() and lines[i][0].isspace():
        b=sum(map(len,lines[:i]))+len(lines[i].rstrip('\r\n'));i+=1
    raw=text[a:b]
    # Current linked entries are single-line Fluent patterns; do not flatten any future multiline producer.
    assert raw==row['english_pattern'],(mid,raw,row['english_pattern'])
    return dict(path=path,start=a,end=b,english=raw,english_location=row['english_location'],fluent_id=row['fluent_id'])


@cache
def prior_contexts(mid):
    rows=json.loads((HERE/'catalog-contexts.json').read_text(encoding='utf-8'))
    return [i+1 for i,r in enumerate(rows[:110]) if r['message_id']==mid]


@cache
def legacy_entries():
    path='packages/cli/src/human-messages.ts';text=read(path);a=text.index('const EN_MESSAGES = {');b=text.index('} satisfies Record<CliMessageId, string>',a);out={}
    needed={n['symbol'] for n in references(FILES[0]) if n['owner']=='CliMessageId'}
    for x,y,k,t in lex(text):
        if k!='string' or not a<x<y<b:continue
        m=re.search(r'\[CliMessageId\.(\w+)\]:\s*$',text[a:x])
        if m and m[1] in needed:
            out[m[1]]=dict(path=path,start=x+1,end=y-1,kind='legacy-default-producer',english=text[x+1:y-1],symbol=m[1],message_id=symbol_ids('CliMessageId')[m[1]])
    assert set(out)==needed
    return out


SOURCE_BLOBS={'packages/cli/locales/en/cli.ftl': '485920e9ffbfd10a830aae6872c5e2dbf3cf3681',
 'packages/cli/src/args.ts': '67dbcaaec8cabe7e2a01e75fefde4afed71e92d4',
 'packages/cli/src/catalog-command.ts': 'd58f53665b7cbee981662c59eb357ccfb9b49335',
 'packages/cli/src/cli-messages.ts': '0452a7dff6ab37939c91f8452888e1ea80af9cba',
 'packages/cli/src/cli.ts': 'a0894d1383f5e3b2676081457dbc2e49ee343e38',
 'packages/cli/src/command-report.ts': '82d35179cd81d12293e9f7cbe9d9e6a1e7df5b44',
 'packages/cli/src/doctor.ts': '74f06aca9f00fab25eef7e883ba005f463a1a6d7',
 'packages/cli/src/human-messages.ts': 'f7e07ce164ee31fcc7192f41c4686a4986b580b3',
 'packages/cli/src/locale-catalog.ts': '22209850c83a4c84cd24954fd874f67287860a48',
 'packages/cli/src/locale-status.ts': '395ca28efbde6d799111d26d0f197dd5687c7cff',
 'packages/cli/src/main-cli.ts': '97ef3313123007e937e6a52064ed6e089e250b57',
 'packages/cli/src/model-catalog-sync.ts': '1e62e854e7132c5569764bb72cd3e9ed94c1ba70',
 'packages/cli/src/model-catalog.ts': '433d87e7f07aa51372f8fba63ccc80d8fbffb704',
 'packages/cli/test/args.test.mjs': '6fd29f0c102b4da69bcec5fd2612b12d22bff5c7',
 'packages/cli/test/catalog-command.test.mjs': '8380d5475987586b045dd1016e3b352e85e72ef5',
 'packages/cli/test/command-report.test.mjs': '225499ca3c41ce6236767d5ed0f1255749a35997',
 'packages/cli/test/locale-status.test.mjs': '024ea33740512911ab2b7220f2c5287d0522e2fe'}
TABLE_HASHES={'cli-command-support-scope.csv': '6b51d0d0fd78795a78d2ab95afd21b34fc97bce328a127d2a57c3edf94e8be16',
 'cli-command-support.csv': 'eaf75f0f2835071bf528b8709f4e838ac4d969dda0e2b42b71cde07bec06d052'}
LEX_COUNTS={'packages/cli/src/args.ts': {'comment': 10, 'interpolation': 4, 'regex': 1, 'string': 217, 'template': 4},
 'packages/cli/src/catalog-command.ts': {'comment': 4, 'interpolation': 10, 'string': 54, 'template': 5},
 'packages/cli/src/locale-status.ts': {'comment': 26, 'interpolation': 5, 'regex': 1, 'string': 38, 'template': 5}}

BOUNDS={
'descriptor-default-vs-active':(FILES[0],24,60),'raw-javascript-string-api':(FILES[0],31,34),
'private-option-guard':(FILES[0],116,131),'parser-dispatch-boundary':(FILES[0],303,397),
'pi-update-bool-boundary':(FILES[0],399,430),'help-layout-boundary':(FILES[0],433,568),
'source-not-found-error-boundary':(FILES[1],72,85),'catalog-notes-data-boundary':(FILES[1],88,162),
'field-map-raw-values-boundary':(FILES[1],165,217),'single-plural-render-boundary':(FILES[1],220,255),
'validation-json-rerender-boundary':(FILES[1],257,296),'locale-original-errors-boundary':(FILES[2],105,159),
'status-context-catch-boundary':(FILES[2],171,192),'state-body-precedence':(FILES[2],199,226),
'plural-unreadable-empty':(FILES[2],234,243),'single-unreadable-unsupported':(FILES[2],252,257),
'reviewed-list-only':(FILES[2],261,269),'bootstrap-usage-sink':('packages/cli/src/cli.ts',153,188),
'catalog-cli-json-human-sink':('packages/cli/src/main-cli.ts',174,231),'main-error-sink':('packages/cli/src/main-cli.ts',862,881),
'doctor-raw-state-sink':('packages/cli/src/doctor.ts',456,470),
'status-producer-default-data':('packages/cli/src/model-catalog-sync.ts',364,464),
'refresh-single-unconfigured-route':('packages/cli/src/model-catalog-sync.ts',780,800),
'conformance-original-message':('packages/cli/src/model-catalog.ts',916,935)}
LOCALE_ERROR_LINES={110,112,114,117,119,122,125,128,130,132,157}


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as file:
        reader=csv.DictReader(file);assert reader.fieldnames==columns;return list(reader)


def main():
    for name,digest in TABLE_HASHES.items():assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('cli-command-support.csv',COLUMNS);scope=table('cli-command-support-scope.csv',SCOPE_COLUMNS)
    assert len(rows)==480 and len(scope)==21 and len({r['source'] for r in scope})==21
    assert all(r['revision']==REVISION for r in scope)
    assert Counter(r['status'] for r in scope)==Counter({'fully-read-cli-command-support':3,'bounded-producer-or-caller-support':10,'excluded-test-fixture-body':4,'finite-scope':1,'read-only-lexical-branch-method':1,'prior-catalog-crosslinks':1,'read-only-source-authority':1})
    assert {r['source'] for r in scope if r['status']=='fully-read-cli-command-support'}==set(FILES)
    hashed=[r for r in scope if r['sha256']];assert len(hashed)==17 and {r['source'] for r in hashed}==set(SOURCE_BLOBS)
    for row in hashed:
        raw=(ROOT/row['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==row['sha256'],row['source']
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==SOURCE_BLOBS[row['source']],row['source']
    assert [len(read(p).splitlines()) for p in FILES]==[568,296,269]
    expected={};refs={}
    for path in FILES:
        assert dict(Counter(k for a,b,k,t in lex(read(path))))==LEX_COUNTS[path]
        for a,b,k,t in tokens(path):expected[(path,a,b,k)]=t
        for n in references(path):
            key=(path,n['start'],n['end'],n['kind']);assert key not in refs;refs[key]=n
    assert len(expected)==320 and len(refs)==103
    assert len({n['message_id'] for n in refs.values()})==99
    assert len(legacy_entries())==33 and len(field_ids())==11
    prior=json.loads((HERE/'catalog-contexts.json').read_text(encoding='utf-8'));assert len(prior)>=110
    seen=set();refs_seen=set();legacy_seen=set();bounds_seen=set();roles=Counter();kinds=Counter();locale_errors=set();contexts_seen=set()

    for index,row in enumerate(rows,1):
        assert row['item_id']==f'CLI-COMMAND-SUPPORT-{index:04d}'
        assert all(row[c] for c in COLUMNS if c not in ('english','message_id'))
        ev=json.loads(row['evidence']);path=ev['path'];text=read(path);a,b=ev['start'],ev['end'];assert 0<=a<b<=len(text)
        assert row['translation_boundary'].startswith(ev['role']+'. ');roles[ev['role']]+=1;kinds[ev['kind']]+=1
        if ev['kind'].startswith('primary-'):
            kind=ev['kind'][8:];ta,tb=ev['token_start'],ev['token_end'];key=(path,ta,tb,kind)
            assert key in expected and key not in seen;seen.add(key)
            x,y=(ta,tb) if kind in ('regex','hashbang') else (ta+1,tb-1)
            assert (a,b)==(x,y) and row['english']==text[a:b]==expected[key] and row['message_id']==''
            assert ev['guards']==guard_evidence(path,ta,tb)
            assert row['english_location']==f'{path}:{text.count(chr(10),0,a)+1}'
            if ev['role']=='fixed-locale-status-api-error':locale_errors.add(text.count('\n',0,a)+1)
        elif ev['kind'] in ('catalog-reference','field-label-catalog-reference'):
            key=(path,a,b,ev['kind']);assert key in refs and key not in refs_seen;refs_seen.add(key);n=refs[key]
            assert row['message_id']==n['message_id']
            for k,value in n.items():assert ev[k]==value,(row['item_id'],k)
            d=catalog_definition(n['message_id']);assert ev['definition']==d
            assert d['fluent_id']==n['message_id'].replace('.','-')
            assert row['english']==d['english'] and row['english_location']==d['english_location']
            assert ev['prior_catalog_context_records']==prior_contexts(n['message_id'])
            for number in ev['prior_catalog_context_records']:
                assert prior[number-1]['message_id']==n['message_id'];contexts_seen.add(number)
        elif ev['kind']=='legacy-default-producer':
            symbol=ev['symbol'];assert symbol in legacy_entries() and symbol not in legacy_seen;legacy_seen.add(symbol);n=legacy_entries()[symbol]
            for k,value in n.items():assert ev[k]==value,(row['item_id'],k)
            assert row['message_id']==n['message_id'] and row['english']==n['english']==text[a:b]
            assert row['english_location']==f'{path}:{text.count(chr(10),0,a)+1}'
            assert ev['catalog_definition']==catalog_definition(n['message_id'])
            assert ev['args_consumers']==[{k:value for k,value in r.items() if k in ('start','end','symbol')} for r in references(FILES[0]) if r['message_id']==n['message_id']]
            assert ev['prior_catalog_context_records']==prior_contexts(n['message_id'])
        else:
            assert ev['kind']=='delivery-boundary' and row['english']=='' and row['message_id']==''
            name=ev['boundary_name'];assert name in BOUNDS and name not in bounds_seen;bounds_seen.add(name)
            p,lo,hi=BOUNDS[name];assert path==p and ev['line_end']==hi and ev['role']==name
            ls=text.splitlines(keepends=True);assert a==sum(map(len,ls[:lo-1])) and b==sum(map(len,ls[:hi]))
            assert row['english_location']==f'{path}:{lo}'
    assert seen==set(expected) and refs_seen==set(refs) and legacy_seen==set(legacy_entries()) and bounds_seen==set(BOUNDS)
    assert len(contexts_seen)==59 and locale_errors==LOCALE_ERROR_LINES and roles['fixed-locale-status-api-error']==11
    assert len({r['message_id'] for r in rows if r['message_id']})==99
    assert sum(bool(r['message_id']) for r in rows)==136
    assert roles['protected-help-usage-syntax']==25 and roles['protected-field-map-fallback-key']==11
    assert roles['protected-support-state']==16
    # Source-only branch/sink proof. No JS/TS function is imported or run.
    guards={
        FILES[0]:['if (typeof raw === "string")','super(raw);','super(resolveHumanMessage(message));','super(catalogMessageText(defaultCatalog(), message));','Object.defineProperty(this, "descriptor", { value: message, enumerable: false });','return error.descriptor ? catalogText(catalog, error.descriptor.id, error.descriptor.args) : error.message;','if (token.startsWith(equalsPrefix))','if (token !== option)','token === "--profile" || token.startsWith("--profile=")','token === "--jouzu-home" || token.startsWith("--jouzu-home=")','token === "--jouzu-profile" || token.startsWith("--jouzu-profile=")','token === "--jouzu-ui-locale" || token.startsWith("--jouzu-ui-locale=")','if (columns - terminalTextWidth(prefix) < 12)','tty && columns < 56 ? 4 : 44'],
        FILES[1]:['if (!status.configured) return [];','if (status.conflict) notes.push({ status: "warning", key, message: status.conflict });','const id = CATALOG_FIELD_LABEL_IDS[fallback];','return id === undefined ? fallback : catalogText(catalog, id);','const single = !("sources" in status);','.paragraph(status.message)','if (status.status === "unconfigured") return out.paragraph(text(CatalogMessageId.catalogUnconfigured)).toString();','Object.defineProperty(result.error, "messageRef", { value: messageRef, enumerable: false });','return ref === undefined ? (result.error?.message ?? "") : catalogMessageText(catalog, ref);','message: catalogMessageText(defaultCatalog(), messageRef)','return checkCatalogConformance(readFileSync(path, "utf8"), { remote });'],
        FILES[2]:['if (context === undefined) return [];','if (context === undefined) return "unsupported";','if (entry === undefined) return "unsupported";','return Object.keys(record.locales).filter((locale) => record.locales[locale].reviewed);','if (entry.sourceDigest !== context.sourceDigest) return "stale";','if (context.sourceMessageIds === undefined) return "complete";'],
        'packages/cli/src/human-messages.ts':['export function resolveHumanMessage(message: HumanMessage, locale: HumanLocale = "en"): string {','const table = MESSAGE_TABLES[locale] ?? MESSAGE_TABLES.en;'],
        'packages/cli/src/cli-messages.ts':['Object.freeze({','defaultBundle ??= resolveCatalog("en").bundle;','return bundle.format(id, plainArguments(args));'],
        'packages/cli/src/cli.ts':['message: protectedSourceError(usageErrorMessage(error, catalog))','preRuntime = englishContext();'],
        'packages/cli/src/main-cli.ts':['console.log(parsed.json ? JSON.stringify(status, null, 2) : formatCatalogStatus(status, renderOptions));','? JSON.stringify(result, null, 2)','message: catalogValidationMessage(result, preRuntime.catalog.bundle)','usageErrorMessage(error, catalog)','const catalogSupport = catalogSupportStates();'],
        'packages/cli/src/doctor.ts':['if (catalog.effective !== catalog.requested) return "fallback";','return support.find((entry) => entry.locale === effective)?.state ?? "unsupported";','if (entries.length === 0) return catalogMessage(CatalogMessageId.doctorValueUnavailable);'],
        'packages/cli/src/model-catalog-sync.ts':['message: catalogText(defaultCatalog(), CatalogMessageId.catalogUnconfigured)','if (sources.length === 0) return { status: "unconfigured", catalogStatus: unconfiguredStatus() };'],
        'packages/cli/src/model-catalog.ts':['return { valid: false, error: { code: error.code, path: error.path, message: error.message } };'],
        'packages/cli/src/locale-catalog.ts':['export const CATALOG_LOCALES = ["en", "ja"] as const;'],
    }
    for path,fragments in guards.items():
        for fragment in fragments:assert fragment in read(path),(path,fragment)
    code=code_mask(FILES[0]);calls=[m for m in re.finditer(r'\breadOptionValue\(',code) if not re.search(r'function\s*$',code[:m.start()])]
    assert [read(FILES[0]).count('\n',0,m.start())+1 for m in calls]==[254,311,318,328]
    labels=[n['symbol'] for n in references(FILES[1]) if n['kind']=='field-label-catalog-reference'];assert len(labels)==len(set(labels))==11 and set(labels)==set(field_ids())
    states=read(FILES[2]);assert states.index('if (entry.sourceDigest !== context.sourceDigest)')<states.index('if (context.sourceMessageIds === undefined)')<states.index('messageIds = new Set(Object.keys(loadCatalog(locale, options).messages))')
    plural=states[states.index('export function catalogSupportStates'):states.index('export function catalogSupportState(')]
    single=states[states.index('export function catalogSupportState('):states.index('export function reviewedCatalogLocales')]
    reviewed=states[states.index('export function reviewedCatalogLocales'):]
    assert 'if (context === undefined) return [];' in plural and 'return "unsupported";' in single and 'return [];' in reviewed
    assert 'stateForEntry' not in reviewed and 'isOfferedCatalogLocale' not in reviewed
    # Empty literals/comments are protected structural material, counted by full frozen lexer census.
    assert sum(k=='comment' for path in FILES for a,b,k,t in lex(read(path)))==sum(x.get('comment',0) for x in LEX_COUNTS.values())
    for name in TABLE_HASHES:
        assert not any(line.rstrip()!=line for line in (HERE/name).read_text(encoding='utf-8').splitlines()),name
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text(encoding='utf-8').splitlines())
    print('PASS cli-command-support:480rows=320literals+103catalogRefs+33legacyProducers+24boundaries;3bodies/1133lines;99existing IDs/59prior contexts;21scope/17SHA256+main-blob identities. Source-only; no parser/UI/state execution.')


if __name__=='__main__':main()
