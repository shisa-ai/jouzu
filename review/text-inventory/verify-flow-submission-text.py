#!/usr/bin/env python3
"""Verify submission store/view inventory by reading CSV and pinned source only.

Run: python -B review/text-inventory/verify-flow-submission-text.py
No audited store/ownership/queue/callback/UI/native/model operation executes.
Pi snippets use existing qualified1.4.0 dependency sources, never installation.
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
S=P+'submission-store.ts';V=P+'submission-view.ts'
FULL={S:1628,V:210}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: CatalogMessageId\.(\w+)$')
HELPER=re.compile(r'\b(?:validateHold|validateNativeInput|validateSubmission|encode|decode|historyPosition)\(')
CACHE={};NPM={}
ARTIFACT_SHA256={'flow-submission-text.csv': '34cce054d602878ef8cdb35435fa179004eb7c9654808682e7042f0b92bcbb3a', 'flow-submission-text-scope.csv': '495ce2b890fed0dd57d34c113ff5be284ca2aa7cec44d77038bbec456c7de350'}

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
    for name,digest in ARTIFACT_SHA256.items():assert hashlib.sha256((HERE/name).read_bytes()).hexdigest()==digest, name+' inventory bytes changed; review English/route ledger before updating digest'
    rows=read('flow-submission-text.csv',FIELDS);scope=read('flow-submission-text-scope.csv',SF)
    assert (len(rows),len(scope))==(117,1058),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-SUBMISSION-TEXT-{n:03}' for n in range(1,118)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-SUBMISSION-TEXT-SCOPE-{n:04}' for n in range(1,1059)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1838
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            p=r['path'];assert p not in pinned,p;pinned.add(p)
            assert hashlib.sha256(source_bytes(p)).hexdigest()==r['sha256'],p
            if p.startswith('npm:'):native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(25,8),(len(pinned),native)
    aliases=dict(re.findall(r'\b(flowSubmission\w+): "([^"]+)"',source_bytes('packages/cli/src/cli-messages.ts').decode()))
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
                symbols.add((p+':'+str(n),'CatalogMessageId.'+alias,l.strip()))
                if not(p==V and n==16):actual.append((p,n,alias))
    assert catalog==actual and len(catalog)==4,(catalog,actual)
    assert {(r['path'],r['coverage'],r['evidence']) for r in scope if r['status']=='imported-catalog-symbol'}==symbols
    assert len(symbols)==5 and len({r['message_id'] for r in rows if r['message_id']})==4
    assert [(p,n) for p in FULL for n,l in enumerate(lines(p),1) if 'defaultCatalog()' in l]==[(V,16),(V,53)]
    for r in rows+scope:
        for value in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',value),'Absolute host path in retained evidence'
            for p,a,b in REF.findall(value):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    total=literal=errors=helpers=catches=0
    exclusions={224,881,941,1287}
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
            elif r['status']=='lexical-excluded-fixed':assert p==S and n in exclusions|{1066},r['scope_id']
        assert observed==tokens,(p,len(tokens),len(observed));total+=len(tokens)
        literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
        ae={n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l)}
        recc={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-constructor'}
        assert ae==set(recc),(p,ae,set(recc));errors+=len(ae)
        for n,r in recc.items():
            assert r['coverage']==at(p,n).strip()
            body={669:671,1590:1592}.get(n,n) if p==S else n
            if p==S and n in exclusions:assert not any(x['english_location']==p+':'+str(body) and x['english'] for x in rows)
            else:assert any(x['english_location']==p+':'+str(body) and x['english'] for x in rows),(p,n,body)
        ah={n for n,l in enumerate(lines(p),1) if HELPER.search(l) and not re.match(r'function ',l)}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-shared-helper-call'}
        assert ah==set(rec),(p,ah,set(rec));helpers+=len(ah)
        for n,r in rec.items():assert r['coverage']==at(p,n).strip()
        ac={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        rec={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert ac==set(rec),(p,ac,set(rec));catches+=len(ac)
        for n,r in rec.items():assert r['coverage']==at(p,n).strip()
    assert (total,literal,errors,helpers,catches)==(545,471,108,33,4),(total,literal,errors,helpers,catches)
    assert kinds=={'catalog':4,'fixed':104,'dynamic':9},kinds
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage']==at(p,int(n)).strip(),r['scope_id']
    assert sum(r['status']=='semantic-anchor' for r in scope)==305
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink'];assert len(prior)==10
    for r in prior:
        name=r['coverage'].split(';',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x.get('path')==r['path'] and (x.get('status','').startswith('full-') or x.get('status','').startswith('reviewed-')) for x in known),(r['path'],name)
    assert {int(r['path'].rsplit(':',1)[1]) for r in scope if r['status']=='excluded-private-invariant'}==exclusions
    # Independent source checks make precedence/nonpublication claims reviewable.
    required={S:{227:'id.length <= 512',546:'if (',547:'archived.length && !state.orderIds',550:'state.orderIds.length !== allIds.length',552:'state.orderIds.some',838:'historyPosition(positions, entry.id)',843:'historyPosition(positions, record.id)',872:'positions.set(entry.id, entry.position)',1066:'reason ?? "Admission revalidated."',1076:'if (reason === undefined)',1078:'holds.splice(index, 1)',1081:'holds.push(captured)',1276:'async (state, _archived, history)',1281:'Invalid submission archive identity.',1285:'captured.flatMap',1287:'Invalid submission archive identity.',1381:'previous.revision !== receipt.revision || previous.consumed !== receipt.consumed',1574:'write.catch(() => {})',1583:'await Promise.all(pending)',1586:'Promise.allSettled(pending)',1588:'await finish("failed")',1591:'[error, receiptError]',1595:'throw error',1597:'await finish("returned")'},V:{16:'defaultCatalog()',32:'record.unavailable || record.status === "cancelled"',34:'!record.dispatch',38:'return false',42:'liveQueue.get(queue.id) === queue.revision',98:'flowSubmissionUnavailable',178:'const reserved',180:'record.status === "cancelled" || fullyCancelled',186:'admission !== "held"',189:'flowSubmissionDeferredContextCancellation',192:'flowSubmissionQueueCancellation',194:'admissionHolds[0]?.reason',196:'flowSubmissionDeliveryUnknown',207:'...(reason ? { reason } : {})'},P+'pi-session-ingress.ts':{141:'error.code === "stale"',142:'throw userInputError',1516:'error.code === "transition"',1518:'submissions.endCallback'},P+'flow-status-report.ts':{172:'catalogText(catalog, CatalogMessageId.flowSubmissionUnavailable)',173:'input.reason === unavailableReason',174:'input.reason !== unavailableReason',188:'flowIngressRecoveryReconciliation',190:'flowDisplayText(input.reason, 240)'},P+'flow-status.ts':{205:'if (status.context) return formatFlowReport',107:'submission.admission === "held" && submission.reason'}}
    for p,ns in required.items():
        for n,expr in ns.items():assert expr in at(p,n),(p,n,expr,at(p,n))
    assert len([l for l in lines(P+'flow-status-extension.ts') if 'cancelWait(target' in l])==1
    assert not any(re.search(r'\.(?:cancelRetained|cancelNativeQueue|cancelNativeContext|archiveSubmissionHistory)\(',l) for l in lines(P+'flow-status-extension.ts'))
    # English fixture is exported but there is no production consumer under src.
    occurrences=[]
    for file in (ROOT/'packages/cli/src').rglob('*.ts'):
        for n,l in enumerate(file.read_text(encoding='utf-8').splitlines(),1):
            if 'UNAVAILABLE_INPUT_REASON' in l:occurrences.append((file.relative_to(ROOT).as_posix(),n))
    assert occurrences==[(V,16)],occurrences
    assert 'notify: () => { }' in at('npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/extensions/runner.js',136)
    assert 'error instanceof Error ? error.message : String(error)' in at('npm:@earendil-works/pi-agent-core@1.4.0/dist/agent.js',438)
    print('PASS flow-submission-text:',len(rows),'rows;',kinds,'; full2/1838 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native support;',errors,'Error constructors/4 private-invariant exclusions;',helpers,'shared helper call sites;',catches,'catches;',total,'lexical tokens/'+str(literal)+' strings/templates; 5 catalog symbols/4 actual projection consumers/2 default sites/10 prior-full crosslinks;',refs,'source references')
if __name__=='__main__':main()
