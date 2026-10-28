#!/usr/bin/env python3
"""Read-only verifier for the session-service/controller-host text inventory.

Run: python -B review/text-inventory/verify-flow-session-service.py
No audited controller/host/storage/native/provider/UI/model operation executes.
Full source closure is limited to the two declared first-party bodies. Native
support uses existing qualified installed1.4.0 source, without installation.
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
S=P+'pi-session-service.ts';H=P+'pi-controller-host.ts'
FULL={S:769,H:311}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: CatalogMessageId\.(\w+)$')
HELPER=re.compile(r'\b(?:captureUserWorkParticipants|consumedUserWork|retainAutomaticWork|finishedUserWork|userWorkId|cancellationSettledSubmission|observedFlowWaits|retainedWaitDecisionIds|inspectPersistedFlowInput|contextAttemptIds|quarantine|flowMemberIncluded)\(')
CACHE={};NPM={}
ARTIFACT_SHA256={'flow-session-service.csv': '37fb3127caab7dba9ee343bd938992f8b813ee1e9cbb9e951701861dddc913bb', 'flow-session-service-scope.csv': '853c5018501ddd07ae9dea5ce4cd4c322fc1f6fa289e58b7bf5f5ec5c4526d0c'}

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
        assert hashlib.sha256(raw).hexdigest()==digest,name+' changed; review context before refreshing digest'
    rows=read('flow-session-service.csv',FIELDS);scope=read('flow-session-service-scope.csv',SF)
    assert (len(rows),len(scope))==(63,720),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-SESSION-SERVICE-{n:03}' for n in range(1,64)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-SESSION-SERVICE-SCOPE-{n:04}' for n in range(1,721)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1080
    for p,n in FULL.items():assert len(lines(p))==n
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            p=r['path'];assert p not in pinned,p;pinned.add(p)
            assert hashlib.sha256(source_bytes(p)).hexdigest()==r['sha256'],p
            if p.startswith('npm:'):native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(27,9),(len(pinned),native)
    aliases=dict(re.findall(r'\b(flowServiceResolved\w+): "([^"]+)"',source_bytes('packages/cli/src/cli-messages.ts').decode()))
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
    assert catalog==actual and len(catalog)==2,(catalog,actual)
    assert {(r['path'],r['coverage'],r['evidence']) for r in scope if r['status']=='imported-catalog-symbol'}==symbols
    assert [(p,n) for p in FULL for n,l in enumerate(lines(p),1) if 'defaultCatalog()' in l]==[(S,521),(S,522)]
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
        assert observed==tokens,(p,len(tokens),len(observed));total+=len(tokens)
        literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
        ae={n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l)}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-constructor'}
        assert ae==set(rec),(p,ae,set(rec));errors+=len(ae)
        for n,r in rec.items():assert r['coverage']==at(p,n).strip() and any(x['english_location']==p+':'+str(n) and x['english'] for x in rows),(p,n)
        ah={n for n,l in enumerate(lines(p),1) if HELPER.search(l) and not l.startswith('function ')}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-imported-helper-call'}
        assert ah==set(rec),(p,ah,set(rec));helpers+=len(ah)
        for n,r in rec.items():assert r['coverage']==at(p,n).strip()
        ac={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert ac==set(rec),(p,ac,set(rec));catches+=len(ac)
        for n,r in rec.items():assert r['coverage']==at(p,n).strip()
    assert (total,literal,errors,helpers,catches)==(266,200,45,14,7),(total,literal,errors,helpers,catches)
    assert kinds=={'catalog':2,'fixed':47,'dynamic':14},kinds
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage']==at(p,int(n)).strip(),r['scope_id']
    assert sum(r['status']=='semantic-anchor' for r in scope)==326
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink'];assert len(prior)==17
    for r in prior:
        name=r['coverage'].split(';',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x.get('path')==r['path'] and (x.get('status','').startswith('full-') or x.get('status','').startswith('reviewed-')) for x in known),(r['path'],name)
    assert any(r['path']==P+'pi-attachment.ts' and r['status']=='prior-full-body-crosslink' for r in scope)
    # Saved reason, actual asynchronous revocation, and command replacement proofs.
    required={S:{104:'Invalid session flow limits.',106:'Session flow attachment requires',133:'[error, closeError]',278:'await this.closeBranch()',308:'["busy", "stale"]',379:'JSON.stringify([',516:'No uncertain attempt',521:'flowServiceResolvedUndelivered',522:'flowServiceResolvedSpent',562:'Emergency flow release from /flow',606:'result.kind === "busy"',622:'No registered work',624:'current === status',625:'["stopped", "completed"]',626:'${current}',644:'live.state !== "waiting"',647:'token, reason, now',758:'Session flow navigation is not prepared'},H:{77:'receipts[i].disposition',78:'Inactive flow input',124:'attached.has(session)',129:'attached.add(session)',147:'quarantine(result, transformedState)',169:'Controller queue consumption',172:'options.consumedAttempt(structuredClone(attempt))',223:'this.pending',224:'revoked: false',228:'pending.revoked',234:'content: input.content',235:'display: true',257:'catch (error)',260:'error.code !== "busy"',275:'Controller input was not consumed',309:'attached.delete(this.session)'},P+'pi-queue-receipts.ts':{100:'await this.ledger.snapshot()',111:'this.dispatches.run(frame, dispatch)'},P+'pi-session-registry.ts':{224:'return this.ownership.run(operation)'},P+'ownership.ts':{118:'this.operations.run(admitted, operation)'},P+'receipt-ledger.ts':{692:'attempt.reason = reason',695:'attempt.phase = "settled"',699:'attempt.phase = "cancelled"',725:'attempt.reason = reason',733:'attempt.reason = reason',737:'attempt.phase = "uncertain"',738:'attempt.reason = reason',781:'attempt.phase = "cancelled"',782:'attempt.reason = reason'},P+'flow-status-extension.ts':{169:'error.code === "busy"',328:'error.code !== "identity"',329:'No interrupted turn',333:'Id.resolvedUndelivered',348:'error.code === "busy"',436:'error.code !== "identity"',437:'No registered work'},P+'flow-status-report.ts':{135:'attempt.reason'},P+'controller.ts':{643:'this.host.enqueue',644:'this.host.run',647:'this.host.reconcile'}}
    for p,ns in required.items():
        for n,expr in ns.items():assert expr in at(p,n),(p,n,expr,at(p,n))
    assert not any(re.search(r'\.(?:retireRequestHistory|retireLedgerHistory|retireResultHistory|retireWaitHistory|archiveSubmissionHistory|cancelNativeSources|cancelNativeProjections|reconcileNativeQueueEdit|cancelNativeQueue|cancelNativeContext)\(',l) for l in lines(P+'flow-status-extension.ts'))
    print('PASS flow-session-service:',len(rows),'rows;',kinds,'; full2/1080 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native support;45 Error constructors/7 catches/14 helper calls;266 lexical tokens/200 strings;2 catalog consumers/default sites;17 prior-full crosslinks;',refs,'source references; LF inventory digests pinned')
if __name__=='__main__':main()
