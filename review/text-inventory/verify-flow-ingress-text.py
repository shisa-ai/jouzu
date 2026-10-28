#!/usr/bin/env python3
"""Verify ingress text inventory using source/CSV reads only.

Run: python -B review/text-inventory/verify-flow-ingress-text.py
No audited ingress/store/callback/model/native/UI/probe/state code executes.
Only pi-session-ingress.ts is newly full-body scope. Pi snippets are pinned
qualified installed1.4.0 bytes, with no install or transitive closure claim.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
P='packages/cli/src/flow-control/';I=P+'pi-session-ingress.ts'
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: CatalogMessageId\.(\w+)$')
HELPER=re.compile(r'\b(?:userInputError|admissionPause|providerPause|decideNativeAdmission|activeAdmissionHolds|captureUserWorkParticipants|retainUserWork|isAdmissionPause|retainedByReceipt|retiredMemberHash)\(')
CACHE={};NPM={}
ARTIFACT_SHA256={'flow-ingress-text.csv': 'b993dc17bc3472e8f8ca43b4daff3b91fa1d97804b7dd72f2df02054f750f5dc', 'flow-ingress-text-scope.csv': '22abe72a1a0b5d23922ca69215251387af3609739ea53b5471d11cf6a6916e0c'}

def native_path(path):
    match=re.fullmatch(r'npm:(@earendil-works/[^@]+)@1\.4\.0/(.*)',path)
    assert match,path
    package,relative=match.groups()
    if package not in NPM:
        for root in [ROOT,*ROOT.parents]:
            for base in [root/'node_modules',root/'packages/cli/node_modules']:
                candidate=base/package
                if (candidate/'package.json').is_file() and (candidate/relative).is_file():
                    metadata=json.loads((candidate/'package.json').read_text(encoding='utf-8'))
                    if metadata.get('name')==package and metadata.get('version')=='1.4.0':
                        NPM[package]=candidate
                        break
            if package in NPM:break
        assert package in NPM,'Pinned native1.4.0 source missing: '+package
    return NPM[package]/relative

def source_bytes(path):
    return (native_path(path) if path.startswith('npm:') else ROOT/path).read_bytes()

def lines(path):
    if path not in CACHE:CACHE[path]=source_bytes(path).decode('utf-8').splitlines()
    return CACHE[path]

def at(path,n):
    assert 1<=n<=len(lines(path)),(path,n)
    return lines(path)[n-1]

def read(name,fields):
    raw=(HERE/name).read_bytes();assert not raw.startswith(b'\xef\xbb\xbf'),name
    with (HERE/name).open(encoding='utf-8',newline='') as f:
        reader=csv.DictReader(f);assert reader.fieldnames==fields,(name,reader.fieldnames)
        return list(reader)

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

def main():
    for name,digest in ARTIFACT_SHA256.items():
        raw=(HERE/name).read_bytes();assert b'\r' not in raw,name+' must use LF'
        assert hashlib.sha256(raw).hexdigest()==digest,name+' changed: review evidence before refreshing digest'
    rows=read('flow-ingress-text.csv',FIELDS);scope=read('flow-ingress-text-scope.csv',SF)
    assert (len(rows),len(scope))==(78,1055),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-INGRESS-TEXT-{n:03}' for n in range(1,79)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-INGRESS-TEXT-SCOPE-{n:04}' for n in range(1,1056)]
    assert [r['path'] for r in scope if r['status']=='reviewed-source']==[I]
    assert len(lines(I))==1627
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            p=r['path'];assert p not in pinned,p;pinned.add(p)
            assert hashlib.sha256(source_bytes(p)).hexdigest()==r['sha256'],p
            if p.startswith('npm:'):native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(27,10),(len(pinned),native)
    aliases=dict(re.findall(r'\b(flow(?:Submission|Ingress)\w+): "([^"]+)"',source_bytes('packages/cli/src/cli-messages.ts').decode()))
    kinds={'catalog':0,'fixed':0,'dynamic':0};catalog=[];refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            kinds['catalog']+=1;pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CONSUMER.search(r['evidence']);assert m,r['item_id'];file,num,alias=m.groups();num=int(num)
            assert 'CatalogMessageId.'+alias in at(file,num) and aliases[alias]==r['message_id'],r['item_id']
            catalog.append((file,num,alias))
        elif r['english']:
            kinds['fixed']+=1;assert r['english'] in at(p,n),r['item_id']
        else:
            kinds['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id']
    actual=[];symbols=set()
    for n,l in enumerate(lines(I),1):
        for alias in re.findall(r'CatalogMessageId\.(\w+)',l):
            actual.append((I,n,alias));symbols.add((I+':'+str(n),'CatalogMessageId.'+alias,l.strip()))
    assert catalog==actual and len(catalog)==5,(catalog,actual)
    assert {(r['path'],r['coverage'],r['evidence']) for r in scope if r['status']=='imported-catalog-symbol'}==symbols
    assert len({r['message_id'] for r in rows if r['message_id']})==5
    assert [(n,l.strip()) for n,l in enumerate(lines(I),1) if 'defaultCatalog()' in l]==[(180,'this.catalog = options.catalog ?? defaultCatalog();')]
    for r in rows+scope:
        for value in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',value),'Absolute host path in retained evidence'
            for p,a,b in REF.findall(value):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    source=source_bytes(I).decode('utf-8');tokens=lex(source);observed=[]
    for r in scope:
        if not(r['path'].startswith(I+':') and r['status'].startswith('lexical-')):continue
        t=json.loads(r['coverage']);a,b,k,v=(t[key] for key in ['start','end','kind','raw']);observed.append((a,b,k,v))
        n=source.count('\n',0,a)+1;assert r['path']==I+':'+str(n) and r['evidence']==at(I,n).strip(),r['scope_id']
        if r['status']=='lexical-inventoried-fixed':
            for rid in r['notes'].removeprefix('Rows: ').split(', '):
                found=next(x for x in rows if x['item_id']==rid)
                assert found['english']==v and found['english_location']==r['path'],rid
        elif r['status']=='lexical-protected-data' and k in ['string','template']:
            static=v
            if k=='template':
                spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
            assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        elif r['status']=='lexical-excluded-fixed':assert n in [853,1033]
    assert observed==tokens,(len(tokens),len(observed))
    assert (len(tokens),sum(k in ['string','template'] for a,b,k,v in tokens))==(374,223)
    errors={n for n,l in enumerate(lines(I),1) if re.search(r'new \w*Error\(',l)}
    records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['status']=='accounted-error-constructor'}
    assert errors==set(records) and len(errors)==41
    for n,r in records.items():
        assert r['coverage']==at(I,n).strip()
        if n in [853,1033]:assert not any(x['english_location']==I+':'+str(n) and x['english'] for x in rows)
        else:assert any(x['english_location']==I+':'+str(n) and x['english'] for x in rows),(n,r)
    helpers={n for n,l in enumerate(lines(I),1) if HELPER.search(l)}
    records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['status']=='accounted-imported-helper-call'}
    assert helpers==set(records) and len(helpers)==17
    factories={n for n,l in enumerate(lines(I),1) if re.search(r'\buserInputError\(',l)}
    assert factories=={137,142,147,165,326,1267}
    for n in factories:assert any(x['english_location']==I+':'+str(n) and x['english'] for x in rows),n
    catches={n for n,l in enumerate(lines(I),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
    records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['status']=='catch-disposition'}
    assert catches==set(records) and len(catches)==29
    for n,r in records.items():assert r['coverage']==at(I,n).strip()
    assert kinds=={'catalog':5,'fixed':54,'dynamic':19},kinds
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage']==at(p,int(n)).strip(),r['scope_id']
    assert sum(r['status']=='semantic-anchor' for r in scope)==522
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink'];assert len(prior)==21
    for r in prior:
        name=r['coverage'].split(';',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x.get('path')==r['path'] and (x.get('status','').startswith('full-') or x.get('status','').startswith('reviewed-')) for x in known),(r['path'],name)
    assert {r['path'] for r in scope if r['status']=='excluded-private-invariant'}=={I+':853',I+':1033'}
    # Guards, catch replacements, raw-reason precedence and prompt persistence are exact source assertions.
    required={I:{141:'error.code === "stale"',142:'throw userInputError',143:'throw error',180:'options.catalog ?? defaultCatalog()',186:'this.session = session',241:'admissionPause(error.code)',250:'providerPause(detail)',374:'error.code !== "stale"',592:'this.automatic?.onError(error)',662:'this.automatedPauseReason = reason',760:'catch (error)',761:'error.code === "capacity"',763:'["busy", "stale"]',785:'this.disposed || this.fenced',813:'reason: hold.reason',845:'attempt.reason ?? catalogText',851:'this.branch()',852:'const service = this.service',853:'if (!service)',1008:'code !== "unauthorized"',1009:'this.holdExternalAuthorization',1071:'this.admitting.run(true',1086:'Host admission policy failed',1088:'throw error',1132:'decision.allowed ? undefined : decision.reason',1140:'reason: decision.reason',1192:'policy.recoveryBlocked',1193:'nativeRequests.recoveryBlocked',1195:'an interrupted turn',1196:'waits.updating',1202:'saved work needs',1242:'(?:flow|about)',1267:'registered adapter path',1269:'if (this.suspended) return dispatch()',1378:'catch',1392:'Use the latest wait snapshot',1393:'liveWaits: liveItems',1419:'display: false',1424:'await session.sendCustomMessage',1425:'!context.completed',1469:'catch (error)',1472:'code !== "unauthorized"',1516:'error.code === "transition"',1518:'submissions.endCallback',1521:'throw error',1532:'return run',1563:'return run',1615:'this.opening?.catch(() => {})',1616:'Promise.allSettled'},P+'flow-runtime.ts':{199:'new PiSessionFlowIngress',204:'catalog,',216:'autoRelease:',218:'status.announcePause',221:'status.announceHeldInput'},P+'flow-status-extension.ts':{41:'Flow control is holding your message',43:'Flow control is holding automated work',82:'!announce || !flowOn',87:'submission.admission === "held"',122:'heldInputNotice(input.reason)',138:'announceRecoveryHold().catch',169:'FlowLedgerError',237:'error instanceof Error ? error.message : String(error)'},P+'flow-status-report.ts':{135:'flowDisplayText(attempt.reason)',172:'flowSubmissionUnavailable',188:'flowIngressRecoveryReconciliation',190:'flowDisplayText(input.reason, 240)'},P+'pi-native-requests.ts':{197:'await decorateContext',200:'captureNativeProjections',437:'projectionCapture'},'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/agent-session.js':{2014:'appendCustomMessageEntry'},'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/export-html/template.js':{1335:"entry.type === 'custom_message'",1336:'entry.display === false',1339:'safeMarkedParse'},'npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/extensions/runner.js':{136:'notify: () => { }'}}
    for p,ns in required.items():
        for n,expr in ns.items():assert expr in at(p,n),(p,n,expr,at(p,n))
    assert not any('admit:' in l for l in lines(P+'flow-runtime.ts')[198:277])
    assert [(n,l.strip()) for n,l in enumerate(lines(I),1) if re.search(r'this\.session\s*=',l)]==[(186,'this.session = session;')]
    uses=[]
    for file in (ROOT/'packages/cli/src').rglob('*.ts'):
        for n,l in enumerate(file.read_text(encoding='utf-8').splitlines(),1):
            if re.search(r'\.heldInputs\(',l):uses.append((file.relative_to(ROOT).as_posix(),n))
    assert not uses,uses
    assert not any(re.search(r'\.(?:cancelRetained|cancelNativeQueue|cancelNativeContext|archiveSubmissionHistory)\(',l) for l in lines(P+'flow-status-extension.ts'))
    print('PASS flow-ingress-text:',len(rows),'rows;',kinds,'; full1/1627 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native support; 41 Error constructors/2 private exclusions; 17 helper calls including6 error factories;29 catches;374 lexical tokens/223 strings/templates;5 catalog occurrences/1 default site;21 prior-full crosslinks;',refs,'source references; LF artifact bytes pinned')
if __name__=='__main__':main()
