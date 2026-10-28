#!/usr/bin/env python3
"""Verify full voice producer/UI inventory without executing product/native code.

Run: python -B review/text-inventory/verify-voice-text.py
Standard-library source/CSV reads only; no microphone, worker, WebSocket,
service, provider, model, native library, UI or user-state execution/inspection.
Pinned Pi1.4.0 consumer snippets are located relative to repository ancestors,
package-version checked and exact-file hashed.
"""
import csv
import hashlib
import json
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
P='packages/cli/src/voice/'
FULL={P+'capture-worker.ts':91,P+'capture.ts':167,P+'errors.ts':25,P+'integration.ts':375,P+'realtime.ts':178,P+'transcript.ts':240}
FIELDS='item_id,message_id,english,english_location,display_location,trigger,consumer_evidence,translation_boundary,evidence'.split(',')
SF='scope_id,path,sha256,status,coverage,evidence,notes'.split(',')
PATH=r'(?:packages/[A-Za-z0-9_@./-]+|npm:@earendil-works/[A-Za-z0-9_-]+@1\.4\.0/[A-Za-z0-9_./-]+)'
REF=re.compile('('+PATH+r'):(\d+)(?:-(\d+))?')
CALL=re.compile(r'catalog call: (packages/[^:;]+):(\d+); expression: (.*)$')
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
    rows=read('voice-text.csv',FIELDS);scope=read('voice-text-scope.csv',SF)
    assert (len(rows),len(scope))==(95,464),(len(rows),len(scope))
    assert [r['item_id'] for r in rows]==[f'VOICE-TEXT-{n:03}' for n in range(1,len(rows)+1)]
    assert [r['scope_id'] for r in scope]==[f'VOICE-TEXT-SCOPE-{n:04}' for n in range(1,len(scope)+1)]
    assert {r['path'] for r in scope if r['status']=='reviewed-source'}==set(FULL)
    assert sum(FULL.values())==1076
    for p,n in FULL.items():assert len(lines(p))==n,(p,n)
    pinned=set();native=0
    for r in scope:
        if r['sha256']:
            assert r['path'] not in pinned,r['path'];pinned.add(r['path'])
            assert hashlib.sha256(source_bytes(r['path'])).hexdigest()==r['sha256'],r['path']
            if r['path'].startswith('npm:'):
                native+=1;assert r['evidence']=='Pi1.4.0 qualified source'
            else:assert r['evidence']==PIN
    assert (len(pinned),native)==(16,5),(len(pinned),native)
    counts={'catalog':0,'fixed':0,'dynamic':0};calls=set();ids=set();refs=0
    for r in rows:
        assert all(r[k] for k in FIELDS if k not in ['message_id','english']),r['item_id']
        p,n=r['english_location'].rsplit(':',1);n=int(n);assert p in pinned,p;at(p,n)
        if r['message_id']:
            counts['catalog']+=1;ids.add(r['message_id']);pattern=r['english'].splitlines();assert pattern
            assert at(p,n)==r['message_id'].replace('.','-')+' = '+pattern[0],r['item_id']
            if len(pattern)>1:assert lines(p)[n:n+len(pattern)-1]==pattern[1:],r['item_id']
            m=CALL.search(r['evidence']);assert m,r['item_id'];file,num,expr=m.groups();num=int(num);assert expr in at(file,num),r['item_id'];calls.add((file,num,expr,r['message_id']))
        elif r['english']:
            counts['fixed']+=1;assert r['english'] in at(p,n),r['item_id']
        else:
            counts['dynamic']+=1;e=r['evidence'].partition('expression: ')[2];assert e and e in at(p,n),r['item_id']
    for r in rows+scope:
        for v in r.values():
            assert not re.search(r'(?<![A-Za-z])[A-Za-z]:[/\\]',v),'Absolute host path in public evidence'
            assert not re.search(r'packages/[^\s;,]+\.ts\d',v),'Missing source reference colon'
            for p,a,b in REF.findall(v):
                assert p in pinned,p;at(p,int(a))
                if b:assert int(a)<=int(b);at(p,int(b))
                refs+=1
    aliases=dict(re.findall(r'^\s*(\w+): "(jouzu\.cli\.[^"]+)",$','\n'.join(lines('packages/cli/src/cli-messages.ts')),re.M))
    accounted={(r['path'],r['coverage']):r for r in scope if r['status']=='accounted-catalog-reference'};actual=set();excluded=set()
    for p in FULL:
        for n,l in enumerate(lines(p),1):
            for expr in re.findall(r'\bCatalogMessageId\.\w+',l):
                mid=aliases[expr.split('.')[1]];where=p+':'+str(n);actual.add((where,expr));assert (where,expr) in accounted,(where,expr)
                found=[r['item_id'] for r in rows if r['evidence']=='Source-traced only; catalog call: '+where+'; expression: '+expr]
                if found:assert accounted[(where,expr)]['evidence']=='Rows: '+', '.join(found),(where,expr)
                else:
                    excluded.add((p,n));assert any(r['path']==where and r['status'].startswith('excluded-') and r['coverage']==mid for r in scope),(p,n,mid)
    assert actual==set(accounted) and len(actual)==54
    assert excluded=={(P+'integration.ts',287),(P+'capture.ts',154),*((P+'transcript.ts',n) for n in [26,32,87,110,114,238])},excluded
    total=literal=0
    for p in FULL:
        source=source_bytes(p).decode('utf-8');tokens=lex(source);records=[r for r in scope if r['path'].startswith(p+':') and r['status'].startswith('lexical-')];observed=[]
        for r in records:
            t=json.loads(r['coverage']);a=t['start'];b=t['end'];k=t['kind'];v=t['raw'];observed.append((a,b,k,v))
            assert int(r['path'].rsplit(':',1)[1])==source.count('\n',0,a)+1,r['scope_id']
            if r['status']=='lexical-inventoried-fixed':
                for rid in r['notes'].removeprefix('Rows: ').split(', '):
                    match=next(x for x in rows if x['item_id']==rid);assert match['english']==v and match['english_location']==r['path'],rid
            elif r['status']=='lexical-protected-data' and k in ['string','template']:
                static=v
                if k=='template':
                    spans=[(x-a-1,y-a-1) for x,y,kind,raw in tokens if kind=='interpolation' and a<x<y<b]
                    for x,y in sorted(spans,reverse=True):static=static[:x]+static[y:]
                assert not(len(re.findall(r'[A-Za-z]{2,}',static))>=2 and ' ' in static),r['scope_id']
        assert tokens==observed,(p,len(tokens),len(observed));total+=len(tokens);literal+=sum(k in ['string','template'] for a,b,k,v in tokens)
    assert (total,literal)==(279,242),(total,literal)
    producers=catches=0
    for p in FULL:
        actualproducers={n for n,l in enumerate(lines(p),1) if re.search(r'new (?:Error|VoiceError|VoiceReviewRequired)\(|\bsuper\(|\bvoiceError\(',l) and not re.search(r'export function voiceError',l)}
        records={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status'].startswith('accounted-error-producer')}
        assert actualproducers==set(records),(p,actualproducers,set(records));producers+=len(actualproducers)
        for n,r in records.items():assert r['coverage']==at(p,n).strip()
        actualcatches={n for n,l in enumerate(lines(p),1) if re.search(r'\bcatch\b',l) and not l.lstrip().startswith(('//','*','/*'))}
        caught={int(r['path'].rsplit(':',1)[1]):r for r in scope if r['path'].startswith(p+':') and r['status']=='catch-disposition'}
        assert actualcatches==set(caught),(p,actualcatches,set(caught));catches+=len(actualcatches)
        for n,r in caught.items():assert r['coverage']==at(p,n).strip()
    assert (producers,catches)==(42,13),(producers,catches)
    for r in scope:
        if r['status']=='semantic-anchor':
            p,n=r['path'].rsplit(':',1);assert r['coverage'] in at(p,int(n)),r['scope_id']
    # Aliased capture identities are accounted per consumer, not declared visible just by membership.
    cp=P+'capture.ts'
    actualalias={n for n,l in enumerate(lines(cp),1) if 'CAPTURE_FAILED' in l and n!=17}
    recorded={int(r['path'].rsplit(':',1)[1]) for r in scope if r['status'] in ['capture-alias-consumer','capture-alias-suppressed-consumer']}
    assert actualalias==recorded=={106,110,112,117,134,136,140,149}
    assert len([r for r in rows if 'catalog call: '+cp+':17;' in r['evidence']])==7
    it=P+'integration.ts'
    for n,count in [(54,3),(138,3),(152,3),(158,2),(186,2),(191,2),(307,2),(335,4)]:assert len([r for r in rows if 'catalog call: '+it+':'+str(n)+';' in r['evidence']])==count,(n,count)
    assert len([r for r in rows if r['english_location']==it+':341'])==8
    # Fluent select keys remain protected; displayed footer branch wording is catalog text.
    statusrows=[r for r in rows if 'catalog call: '+it+':138;' in r['evidence']]
    assert all('{ $state ->' in r['english'] and '[recording] recording' in r['english'] for r in statusrows)
    assert not any(r['english_location'] in [it+':224',it+':280',it+':161'] and r['english'] in ['starting','recording','finishing'] for r in rows)
    assert len([r for r in scope if r['status']=='protected-fluent-select-key'])==3
    # Default producer closure for no-identity VoiceError branch and completion grammar.
    production=list((ROOT/'packages/cli/src').rglob('*.ts'))
    direct=[(p.relative_to(ROOT).as_posix(),n) for p in production for n,l in enumerate(p.read_text(encoding='utf-8').splitlines(),1) if re.search(r'new VoiceError\(',l)]
    assert direct==[(P+'errors.ts',24)],direct
    assert 'VoiceReviewRequired' in at(it,177) and 'finishReject?.(error as Error)' in at(P+'realtime.ts',129)
    assert counts=={'catalog':66,'fixed':11,'dynamic':18},counts
    assert len(ids)==46,len(ids)
    print('PASS voice-text:',len(rows),'rows;',counts,';',len(ids),'catalog IDs;',len(FULL),'full bodies/1076 lines;',len(scope),'scope rows;',len(pinned),'hashes/'+str(native)+' native;',len(actual),'catalog references;',producers,'error producers;',catches,'catch sites;',total,'lexical tokens/'+str(literal)+' strings/templates;',refs,'source references')

if __name__=='__main__':main()
