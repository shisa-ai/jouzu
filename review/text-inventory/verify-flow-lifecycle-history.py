#!/usr/bin/env python3
"""Verify the BASE346 lifecycle/history inventory with source/CSV reads only.

Run: python -B review/text-inventory/verify-flow-lifecycle-history.py
No audited algorithm, native/UI/model/storage/state operation is executed.
Five first-party bodies are full; installed Pi1.4.0 sources only support
bounded consumer/cleanup assertions, without installation or OS claims.
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
H=P+'pi-host-boundary.ts';N=P+'pi-navigation-guard.ts';G=P+'pi-session-registry.ts';B=P+'pi-branch-binding.ts';R=P+'pi-history-recovery.ts'
FULL={H:458,N:98,G:493,B:320,R:95}
EX={(G,337),(B,223)}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CACHE={};NPM={}
HELPER=re.compile(r'\b(?:assertActive|assertWritable|assertOperationAvailable|navigationFrame|operation|execution|wrap|idle|commandIdle|notifyDrained|releaseFrame|atRest|hasFlowHandoff|compactionHistoryEnd|sessionEntryToContextMessages|assertAvailable|syncCall|asyncCall|navigate|validate|stateBytes|retireRecords|dropOldest|recordDeparture|validPosition|identity|leaf|samePosition|neverNavigated|memoryInstance|markerFrom|latestMarker|assertSession|evidence|appendMarker|assertPosition|assertRegistry|reactivationTarget|navigationPosition|canResume|piTranscriptBranchOwners|verifyPiHistoryEntry|verifyPiHistoryEntries|inspectPersistedFlowInput|assertCurrent)\(')
ARTIFACT_SHA256={'flow-lifecycle-history.csv': '42d00d509ff8ab3dc8b1c71ad93b0bd73680c2f496a631ade83c292ed316314d', 'flow-lifecycle-history-scope.csv': '2b9b6e456cf904b0fa0121925b570b552cb3c0fa7f4447b3f445b3b4c1478aea'}

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

def validate(rows,scope):
    assert (len(rows),len(scope))==(94,2952),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-LIFECYCLE-HISTORY-{n:03}' for n in range(1,95)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-LIFECYCLE-HISTORY-SCOPE-{n:04}' for n in range(1,2953)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1464
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            p=r['path'];assert p not in pinned;pinned.add(p)
            assert hashlib.sha256(source_bytes(p)).hexdigest()==r['sha256'],p
            assert r['evidence']==('Pi1.4.0 qualified source' if p.startswith('npm:') else PIN),p
            native+=p.startswith('npm:')
    assert (len(pinned),native)==(21,6),(len(pinned),native)
    fixed=dynamic=refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        assert not r['message_id'],'No catalog source in five bodies'
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in FULL
        if r['english']:
            fixed+=1;assert r['english'] in at(p,n),r['item_id']
        else:
            dynamic+=1;expr=r['evidence'].partition('expression: ')[2];assert expr and expr in at(p,n),r['item_id']
    assert (fixed,dynamic)==(79,15),(fixed,dynamic)
    for r in rows+scope:
        for v in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',v),'Host absolute path in retained evidence'
            for p,a,b in REF.findall(v):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    counts=[0,0,0,0,0]
    for p,n in FULL.items():
        assert len(lines(p))==n
        source=source_bytes(p).decode('utf-8');tokens=lex(source);observed=[]
        assert not re.search(r'CatalogMessageId\.|\bcatalogText\(|\bdefaultCatalog\(',source),p
        for r in scope:
            if not(r['path'].startswith(p+':') and r['status'].startswith('lexical-')):continue
            t=json.loads(r['coverage']);a,b,k,v=(t[x] for x in ['start','end','kind','raw']);observed.append((a,b,k,v))
            num=source.count('\n',0,a)+1;assert r['path']==p+':'+str(num) and r['evidence']==at(p,num).strip(),r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    match=next(x for x in rows if x['item_id']==rid);assert match['english']==v and match['english_location']==r['path'],rid
            elif r['status']=='lexical-excluded-fixed':assert (p,num) in EX and ' ' in v
            elif r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),(r['scope_id'],v)
        assert observed==tokens,(p,len(tokens),len(observed));counts[0]+=len(tokens)
        counts[1]+=sum(k in ['string','template'] for a,b,k,v in tokens)
        ae={num for num,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l) and not l.lstrip().startswith(('//','*','/*'))}
        er={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-constructor'}
        assert ae==set(er),(p,ae,set(er));counts[2]+=len(ae)
        for num,r in er.items():
            assert r['coverage']==at(p,num).strip()
            found=[x for x in rows if x['english_location']==p+':'+str(num) and x['english']]
            assert bool(found)==((p,num) not in EX),(p,num)
        ah={num for num,l in enumerate(lines(p),1) if HELPER.search(l) and not l.lstrip().startswith(('function ','private ','export function ','export async function '))}
        hs={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-helper-call-line'}
        assert ah==set(hs),(p,ah,set(hs));counts[3]+=len(ah)
        for num,r in hs.items():assert r['coverage']==at(p,num).strip() and ', '.join(HELPER.findall(at(p,num))) in r['evidence']
        ac={num for num,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        cs={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert ac==set(cs),(p,ac,set(cs));counts[4]+=len(ac)
        for num,r in cs.items():assert r['coverage']==at(p,num).strip()
    assert counts==[421,330,78,168,4],counts
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage']==at(p,int(n)).strip(),r['scope_id']
    assert sum(r['status']=='semantic-anchor' for r in scope)==2245
    assert {r['path'] for r in scope if r['status']=='excluded-private-invariant'}=={p+':'+str(n) for p,n in EX}
    assert sum(r['status']=='lexical-excluded-fixed' for r in scope)==2
    for r in scope:
        if r['status']=='prior-full-body-crosslink':
            name=r['coverage'].split(';',1)[0]
            with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
            assert any(x.get('path')==r['path'] and (x.get('status','').startswith('full-') or x.get('status','').startswith('reviewed-')) for x in known),(r['path'],name)
    # Bounded route invariants: public undefined-attempt witness remains primary;
    # two private missing-record cases are excluded only after validated snapshots.
    required={H:{137:'return dispose()',138:'catch (error)',139:'this.disposalRequested = previous',194:'listener(cause)',253:'if (!this.navigationReleased) await this.session.abort()',280:'parent?.kind === "boundary"',348:'this.barrier ||',349:'kind: "busy"',356:'await this.frames.run(frame, run)',375:'state.activeAttemptId !== attemptId',377:'Settlement attempt is missing.',381:'ledger.cancel',393:'ledger.withholdRequest',398:'ledger.uncertain',403:'if (current.reason)',404:'ledger.settle'},G:{170:'Session registry has an inconsistent active branch.',179:'pending.fromBranchId !== state.activeBranchId',210:'this.validate(state)',211:'update(state)',213:'this.validate(state)',337:'if (!pending || !from)',350:'this.recordDeparture(state)',406:'await writeFile',408:'catch',409:'return undefined',468:'this.recordDeparture(state)',489:'await closeBranches?.()',490:'this.session.close'},B:{223:'if (!branch)',248:'await registry.rebuildFromMarker',249:'onRebuiltRegistry?.(rebuilt.isolated)',284:'!pending || pending.id !== transitionId'},R:{16:'state.activeAttemptId',72:'await verifyPiHistoryEntries',81:'proof?.kind !== "persisted"',82:'unresolved++',89:'await ledger.recoverHistory'},P+'receipt-ledger.ts':{635:'attempt.reason = reason',636:'hasFlowHandoff(attempt) ? "running" : "withheld"',667:'attempt.phase = "uncertain"',668:'attempt.reason = reason'},P+'pi-session-ingress.ts':{842:'attempt.phase === "uncertain"',845:'attempt.reason ?? catalogText',1516:'error.code === "transition"'},P+'flow-status.ts':{205:'if (status.context) return formatFlowReport'},P+'flow-status-report.ts':{135:'flowDisplayText(attempt.reason)'},'npm:@earendil-works/pi-coding-agent@1.4.0/dist/modes/interactive/interactive-mode.js':{4735:'this.showError(error instanceof Error ? error.message : String(error))',3799:'Error: ${errorMessage}'}}
    for p,anchors in required.items():
        for n,expr in anchors.items():assert expr in at(p,n),(p,n,expr,at(p,n))
    return refs

def main():
    for name,digest in ARTIFACT_SHA256.items():
        raw=(HERE/name).read_bytes();assert b'\r' not in raw and not raw.startswith(b'\xef\xbb\xbf'),name+' requires UTF8/LF without BOM'
        assert hashlib.sha256(raw).hexdigest()==digest,name+' changed; review before refreshing digest'
    rows=read('flow-lifecycle-history.csv',FIELDS);scope=read('flow-lifecycle-history-scope.csv',SF)
    refs=validate(rows,scope)
    print('PASS flow-lifecycle-history:94 rows/79 fixed/15 dynamic;full5/1464 lines;2952 scope;21 hashes/6 native supporting;78 Error constructors/2 private invariants;4 catches/168 named helper call lines;421 tokens/330 strings;0 catalogs/defaults;6 prior-full crosslinks;',refs,'source references;LF digests pinned')

if __name__=='__main__':main()
