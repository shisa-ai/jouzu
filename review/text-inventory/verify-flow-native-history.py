#!/usr/bin/env python3
"""Verify native-history text inventory through source and CSV reads only.

Run: python -B review/text-inventory/verify-flow-native-history.py
No audited native/queue/history scanner/recovery/model/UI/user-state operation
executes. Six first-party bodies are full scope; native supporting snippets use
existing qualified1.4.0 installed sources, without installation or OS claims.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
P='packages/cli/src/flow-control/'
D=P+'pi-native-dispatch.ts';H=P+'pi-native-history.ts';R=P+'pi-native-source-recovery.ts'
READ=P+'pi-history-reader.ts';HR=P+'pi-history-receipts.ts';Q=P+'pi-queue-receipts.ts'
FULL={D:714,H:274,R:225,READ:308,HR:120,Q:142}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: CatalogMessageId\.(\w+)$')
HELPER=re.compile(r'\b(?:assertActive|frame|drainContext|assertCurrent|assertContent|add|matchesInput|verifyPiHistoryEntries|verifyPiHistoryEntry|recoverNativeSources|retainMemorySource|persistedAgentMessage|persistedValue|observed|memorySourceReceipts|readerFor|stamp|sameFile|sameStamp)\(')
CACHE={};NPM={}
ARTIFACT_SHA256={'flow-native-history.csv': '5a6f000c8599e89f9d268c97bd25ef682a0427f3babb84501ac913be8816add7', 'flow-native-history-scope.csv': 'a4140a36477d1b7fed111e786ff6a025f0bacfb4ab6348a34ff4e48a4d648672'}

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
        assert hashlib.sha256(raw).hexdigest()==digest,name+' changed; review contexts before refreshing digest'
    rows=read('flow-native-history.csv',FIELDS);scope=read('flow-native-history-scope.csv',SF)
    assert (len(rows),len(scope))==(107,1111),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-NATIVE-HISTORY-{n:03}' for n in range(1,108)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-NATIVE-HISTORY-SCOPE-{n:04}' for n in range(1,1112)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1783
    for p,n in FULL.items():assert len(lines(p))==n
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            p=r['path'];assert p not in pinned,p;pinned.add(p)
            assert hashlib.sha256(source_bytes(p)).hexdigest()==r['sha256'],p
            if p.startswith('npm:'):native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(31,10),(len(pinned),native)
    aliases=dict(re.findall(r'\b(flowNative\w+): "([^"]+)"',source_bytes('packages/cli/src/cli-messages.ts').decode()))
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
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for alias in re.findall(r'CatalogMessageId\.(\w+)',l):
                actual.append((p,n,alias));symbols.add((p+':'+str(n),'CatalogMessageId.'+alias,l.strip()))
    assert catalog==actual and len(catalog)==4,(catalog,actual)
    assert {(r['path'],r['coverage'],r['evidence']) for r in scope if r['status']=='imported-catalog-symbol'}==symbols
    assert [(p,n) for p in FULL for n,l in enumerate(lines(p),1) if 'defaultCatalog()' in l]==[(D,69)]
    for r in rows+scope:
        for value in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',value),'Absolute host path in retained evidence'
            for p,a,b in REF.findall(value):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    total=literal=errors=helpers=catches=0
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source);observed=[]
        for r in scope:
            if not(r['path'].startswith(p+':') and r['status'].startswith('lexical-')):continue
            t=json.loads(r['coverage']);a,b,k,v=(t[key] for key in ['start','end','kind','raw']);observed.append((a,b,k,v))
            n=source.count('\n',0,a)+1;assert r['path']==p+':'+str(n) and r['evidence']==at(p,n).strip(),r['scope_id']
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
            elif r['status']=='lexical-excluded-fixed':assert p==R and n==176
        assert observed==tokens,(p,len(tokens),len(observed));total+=len(tokens)
        literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
        ae={n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l)}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-constructor'}
        assert ae==set(rec),(p,ae,set(rec));errors+=len(ae)
        for n,r in rec.items():
            assert r['coverage']==at(p,n).strip()
            if p==R and n==176:assert not any(x['english_location']==p+':'+str(n) and x['english'] for x in rows)
            else:assert any(x['english_location']==p+':'+str(n) and x['english'] for x in rows),(p,n)
        ah={n for n,l in enumerate(lines(p),1) if HELPER.search(l) and not l.lstrip().startswith(('function ','private ','export function ','export async function '))}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-helper-call-line'}
        assert ah==set(rec),(p,ah,set(rec));helpers+=len(ah)
        for n,r in rec.items():assert r['coverage']==at(p,n).strip() and ', '.join(HELPER.findall(at(p,n))) in r['evidence']
        ac={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert ac==set(rec),(p,ac,set(rec));catches+=len(ac)
        for n,r in rec.items():assert r['coverage']==at(p,n).strip()
    assert (total,literal,errors,helpers,catches)==(424,347,82,90,13),(total,literal,errors,helpers,catches)
    assert kinds=={'catalog':4,'fixed':82,'dynamic':21},kinds
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage']==at(p,int(n)).strip(),r['scope_id']
    assert sum(r['status']=='semantic-anchor' for r in scope)==438
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink'];assert len(prior)==13
    for r in prior:
        name=r['coverage'].split(';',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x.get('path')==r['path'] and (x.get('status','').startswith('full-') or x.get('status','').startswith('reviewed-')) for x in known),(r['path'],name)
    assert [r['path'] for r in scope if r['status']=='excluded-private-invariant']==[R+':176']
    # Supported-route proof for total history evidence and exact suppressor/replacement behavior.
    required={D:{69:'defaultCatalog()',199:'this.contextFailure = true',219:'flowNativeEditedInput',222:'write.catch',227:'flowNativeObservationRetained',259:'catch',265:'flowNativeQueueAdmission',273:'flowNativeQueueHeld',381:'this.store.recordQueueClaim',382:'() => {}',389:'generation === this.queueGeneration',409:'Promise.all',410:'this.contextFailure',412:'this.queueFailure',556:'heldInputs()',558:'if (!queued.some',559:'structuredClone',569:'this.queueGeneration++',588:'Native input outlived',656:'catch (error)',657:'this.contextFailure = true',661:'Promise.allSettled',684:'Promise.allSettled'},H:{94:'verifyPiHistoryEntry(manager, entry.id)',95:'evidence.kind === "memory"',111:'Native transcript entry was not persisted.',150:'evidence.kind === "buffered"',173:'sources?.length === counts.get(message)',225:'this.prompts.length'},R:{114:'const proofIds',118:'record.dispatch?.promptHistory',120:'projectedIds.has(id)',121:'verifyPiHistoryEntries(manager, proofIds)',170:'const targets',173:'Native history entry has ambiguous',176:'if (!evidence)',217:'apply()',220:'Pi context changed'},READ:{123:'Invalid history record',134:'if (!expected.size) return result',138:'uniform',139:'uniform("memory")',159:'return uniform("buffered")',195:'${maxEntryBytes}',214:'catch',215:'History contains an invalid complete',236:'entries.size > maxIndexEntries',250:'result.set(id, { kind: "buffered" })',270:'catch',271:'History contains an invalid complete',276:'result.set(id, { kind: "persisted"',288:'return result',289:'catch (error)',293:'await file.close()'},HR:{105:'evidence?.kind !== "persisted"',106:'this.ledger.history'},Q:{41:'dispatch.queued.catch',100:'await this.ledger.snapshot()',111:'this.dispatches.run(frame, dispatch)',115:'catch (error)',116:'this.agent.cancelQueuedMessage',117:'frame.queued?.catch',118:'throw error',132:'Native queue item changed'},P+'pi-session-service.ts':{170:'this.options.catalog',173:'native.recoverSources()',179:'native.sources(messages)',181:'native.consumedSources()',583:'branch.native.recoverSources()'},P+'pi-session-ingress.ts':{1516:'error.code === "transition"',785:'this.disposed || this.fenced'},'npm:@earendil-works/pi-agent-core@1.4.0/dist/agent.js':{438:'Error ? error.message : String(error)',498:'await listener'}}
    for p,ns in required.items():
        for n,expr in ns.items():assert expr in at(p,n),(p,n,expr,at(p,n))
    uses=[]
    for file in (ROOT/'packages/cli/src').rglob('*.ts'):
        for n,l in enumerate(file.read_text(encoding='utf-8').splitlines(),1):
            if re.search(r'\.heldInputs\(',l):uses.append((file.relative_to(ROOT).as_posix(),n))
    assert not uses,uses
    assert not any(re.search(r'\.(?:reconcileNativeQueueEdit|cancelNativeQueue|cancelNativeContext)\(',l) for l in lines(P+'flow-status-extension.ts'))
    print('PASS flow-native-history:',len(rows),'rows;',kinds,'; full6/1783 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native support;82 Error constructors/1 private invariant;13 catches/90 named helper call lines;424 lexical tokens/347 strings;4 API/internal held catalogs/1 default;13 prior-full crosslinks;',refs,'source references; LF digests pinned')
if __name__=='__main__':main()
