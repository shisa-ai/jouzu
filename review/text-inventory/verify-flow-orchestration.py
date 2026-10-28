#!/usr/bin/env python3
"""Verify Flow orchestration wording with source/CSV reads only.

Run: python -B review/text-inventory/verify-flow-orchestration.py
No product imports, extension/event callbacks, probes/native/model/network/UI
execution or user-state writes. Pi1.4.0 support files are version/hash checked;
supporting hash presence does not claim full body coverage.
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
FULL={P+'flow-runtime.ts':297,P+'background-adapter.ts':48,P+'background-extension.ts':170,P+'background-results.ts':134,P+'result-tools.ts':72,P+'task-producer.ts':208,P+'task-extension.ts':197,P+'task-context-guard.ts':86,P+'multiloop-producer.ts':280,P+'multiloop-extension.ts':168,P+'compaction-extension.ts':72,P+'subagent-observation-extension.ts':132}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CONSUMER=re.compile(r'catalog consumer: (packages/[^:;]+):(\d+); expression: (.*)$')
IMPORTED=re.compile(r'imported fixed consumer: (packages/[^:;]+):(\d+); expression: (.*)$')
CACHE={};NPM={}

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
    rows=read('flow-orchestration.csv',FIELDS);scope=read('flow-orchestration-scope.csv',SF)
    assert (len(rows),len(scope))==(76,884),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'FLOW-ORCHESTRATION-{n:03}' for n in range(1,77)]
    assert [r['scope_id'] for r in scope]==[f'FLOW-ORCHESTRATION-SCOPE-{n:04}' for n in range(1,885)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1864
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            if r['path'].startswith('npm:'):native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(44,14),(len(pinned),native)
    counts={'catalog':0,'fixed':0,'dynamic':0};consumers=[];imports=[];refs=0
    alias_text=source_bytes('packages/cli/src/cli-messages.ts').decode('utf-8')
    aliases=dict(re.findall(r'\b(flowRegistryRebuiltSaved|flowRegistryRebuilt|flowResultsLabel|flowTaskContinuationSkipped): "([^"]+)"',alias_text))
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CONSUMER.search(r['evidence']);assert m,r['item_id'];file,num,expr=m.groups();num=int(num)
            assert expr in at(file,num),r['item_id'];alias=expr.removeprefix('CatalogMessageId.')
            assert aliases[alias]==r['message_id'],r['item_id'];consumers.append((file,num,alias))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id']
            if 'imported fixed consumer:' in r['evidence']:
                m=IMPORTED.search(r['evidence']);assert m,r['item_id'];file,num,expr=m.groups()
                assert expr in at(file,int(num)),r['item_id'];imports.append((file,int(num),expr))
        else:
            counts['dynamic']+=1;expr=r['evidence'].partition('expression: ')[2]
            assert expr and expr in at(p,n),r['item_id']
    actual=[];default=[]
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for alias in re.findall(r'CatalogMessageId\.(\w+)',l):actual.append((p,n,alias))
            if '?? defaultCatalog()' in l:default.append((p,n))
    assert consumers==actual and len(actual)==4,(consumers,actual)
    assert default==[(P+'flow-runtime.ts',85),(P+'result-tools.ts',18),(P+'task-context-guard.ts',25)],default
    assert imports==[(P+'result-tools.ts',42,'FLOW_OFF_MESSAGE'),(P+'compaction-extension.ts',56,'COMPACTION_CONTINUE_TEXT')],imports
    for r in rows+scope:
        for value in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',value),'Absolute host path in retained evidence'
            for p,a,b in REF.findall(value):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    total=literal=errors=catches=0
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source)
        observed=[]
        for r in scope:
            if not(r['path'].startswith(p+':') and r['status'].startswith('lexical-')):continue
            t=json.loads(r['coverage']);a,b,k,v=(t[key] for key in ['start','end','kind','raw']);observed.append((a,b,k,v))
            n=source.count('\n',0,a)+1;assert r['path']==p+':'+str(n),r['scope_id']
            assert r['evidence']==at(p,n).strip(),r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    found=next(x for x in rows if x['item_id']==rid)
                    assert found['english']==v and found['english_location']==r['path'],rid
            elif r['status']=='lexical-control-sentinel':
                assert p==P+'task-producer.ts' and n==129 and v=='Producer state changed'
            elif r['status']=='lexical-nonemitted-guard':
                assert p==P+'subagent-observation-extension.ts' and n==38 and v=='Read observations cannot schedule work.'
            elif r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        assert observed==tokens,(p,len(tokens),len(observed));total+=len(tokens)
        literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
        actual_errors={n for n,l in enumerate(lines(p),1) if re.search(r'new \w*Error\(',l)}
        recorded={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='accounted-error-constructor'}
        assert actual_errors==set(recorded),(p,actual_errors,set(recorded));errors+=len(actual_errors)
        for n,r in recorded.items():assert r['coverage']==at(p,n).strip()
        actual_catches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        recorded={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actual_catches==set(recorded),(p,actual_catches,set(recorded));catches+=len(actual_catches)
        for n,r in recorded.items():assert r['coverage']==at(p,n).strip()
    assert (total,literal,errors,catches)==(529,397,49,14),(total,literal,errors,catches)
    # Every constructor has an exact English/catalog/import/nonemitted-body disposition.
    locations={r['english_location'] for r in rows}
    bodylines={'flow-runtime.ts':{88:88,169:169,226:228,236:240,250:252,270:272,291:291},'background-adapter.ts':{37:37},'background-extension.ts':{55:55,106:106,109:109,119:119,145:145},'background-results.ts':{95:95,123:123},'result-tools.ts':{42:42,50:50,58:58},'task-producer.ts':{46:46,72:72,92:92,94:96,180:180,182:182,195:195,199:199},'task-extension.ts':{51:51,82:82,88:88},'multiloop-producer.ts':{36:36,62:62,75:75,77:77,100:100,103:103,157:157,159:159,201:203,257:257,267:267,270:270},'multiloop-extension.ts':{39:39,57:57,61:61},'compaction-extension.ts':{30:30,34:34},'subagent-observation-extension.ts':{38:38,89:89,94:94}}
    assert sum(len(v) for v in bodylines.values())==49
    for file,sites in bodylines.items():
        for start,body in sites.items():
            loc=P+file+':'+str(body)
            if file=='flow-runtime.ts' and start==236:assert any(p==P+file and n==body for p,n,alias in consumers)
            elif file=='result-tools.ts' and start==42:assert (P+file,42,'FLOW_OFF_MESSAGE') in imports
            elif file=='subagent-observation-extension.ts' and start==38:assert any(r['path']==loc and r['status']=='nonemitted-private-build-guard' for r in scope)
            else:assert loc in locations,loc
    symbols=set()
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for sym in re.findall(r'\b(?:CatalogMessageId\.[A-Za-z]+|COMPACTION_CONTINUE_TEXT|FLOW_OFF_MESSAGE|REOPENED_PAUSE|SUBAGENT_READ_RECEIPTS|SUBAGENT_READ_RECEIPT)\b',l):symbols.add((p+':'+str(n),sym,l.strip()))
    recorded={(r['path'],r['coverage'],r['evidence']) for r in scope if r['status']=='imported-message-or-control-symbol'}
    assert symbols==recorded and len(symbols)==14,(len(symbols),len(recorded))
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    assert len([r for r in scope if r['status']=='semantic-anchor'])==168
    prior=[r for r in scope if r['status']=='prior-full-body-crosslink'];assert len(prior)==22
    for r in prior:
        name=r['coverage'].split(';',1)[0]
        with (HERE/name).open(encoding='utf-8',newline='') as f:known=list(csv.DictReader(f))
        assert any(x['path']==r['path'] and (x['status'].startswith('full-') or x['status'].startswith('reviewed-')) for x in known),(r['path'],name)
    assert len([r for r in scope if r['status']=='lexical-control-sentinel'])==1
    assert len([r for r in scope if r['status']=='lexical-nonemitted-guard'])==1
    assert 'return [];' in at(P+'subagent-observation-extension.ts',35)
    assert 'attempt?.phase !== "claimed" || !attempt.consumed' in at(P+'pi-controller-host.ts',168)
    assert 'controller.view().producers.length' in at(P+'pi-session-ingress.ts',766)
    assert 'Producer state changed' in at(P+'task-producer.ts',129)
    assert counts=={'catalog':4,'fixed':58,'dynamic':14},counts
    assert rows[23]['item_id']=='FLOW-ORCHESTRATION-024' and 'Qualified alternate' in rows[23]['trigger']
    assert rows[73]['item_id']=='FLOW-ORCHESTRATION-074' and rows[73]['english_location']==P+'background-results.ts:124'
    bus='npm:@earendil-works/pi-coding-agent@1.4.0/dist/core/event-bus.js'
    assert [r['path'] for r in scope if r['status']=='reviewed-native-source']==[bus]
    assert len(lines(bus))==25
    source=source_bytes(bus).decode('utf-8');native_tokens=lex(source);recorded=[]
    for r in scope:
        if r['status'].startswith('native-lexical-'):
            assert r['path'].startswith(bus+':'),r['scope_id'];t=json.loads(r['coverage'])
            a,b,k,v=(t[x] for x in ['start','end','kind','raw']);recorded.append((a,b,k,v))
            n=source.count('\n',0,a)+1;assert r['path']==bus+':'+str(n) and r['evidence']==at(bus,n).strip()
            if r['status']=='native-lexical-fixed':assert v==rows[74]['english']
    assert recorded==native_tokens and len(recorded)==4
    assert sum(k in ['string','template'] for a,b,k,v in native_tokens)==2
    assert not any(re.search(r'new \w*Error\(',l) for l in lines(bus))
    catch=[r for r in scope if r['status']=='native-catch-disposition']
    assert len(catch)==1 and catch[0]['path']==bus+':13' and catch[0]['coverage']==at(bus,13).strip()
    identity=[r for r in scope if r['status']=='canonical-runtime-census-identity'];assert len(identity)==1
    expected=json.loads(identity[0]['coverage'])
    with (HERE/'pi-runtime-census.csv').open(encoding='utf-8',newline='') as f:
        census=next(r for r in csv.DictReader(f) if r['item_id']=='pi.runtime-census.0118')
    assert all(census[k]==v for k,v in expected.items())
    assert expected['source']==bus and expected['package_version']=='1.4.0'
    assert expected['archive_sha256']==hashlib.sha256(source_bytes(bus)).hexdigest()
    assert expected['archive_sha256']==expected['root_sha256']==expected['cli_nested_sha256']
    print('PASS flow-orchestration:',len(rows),'rows;',counts,'; first-party12/1864 lines + full native1/25 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native; 4 catalog IDs/3 default sites; 2 imported fixed consumers;',errors,'first-party Error constructors;',catches,'first-party catches;',total,'first-party tokens/'+str(literal)+' strings/templates; native4 tokens/2 literals/0 Errors/1 catch; 14 imported control refs; 22 prior-full crosslinks; census pi.runtime-census.0118;',refs,'source references')
if __name__=='__main__':main()
