"""Read-only authored CI wording/source inventory. Never loads YAML actions or runs producers."""
import ast,csv,hashlib,io,json,re,tokenize
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
FILES=['.github/workflows/ci.yml', '.github/workflows/launcher-checks.yml', '.github/workflows/launcher-feed-guard.yml', '.github/workflows/launcher-recipe.yml', '.github/workflows/launcher-runtime.yml', '.github/workflows/pi-latest.yml', '.github/workflows/publish-npm.yml', '.github/workflows/publish-pypi.yml', '.github/workflows/test-benchmark.yml', '.github/workflows/textguard-native.yml']
@cache
def read(path):return (ROOT/path).read_text(encoding='utf-8')


@cache
def shell_lex(text):
    """Lossless lexical words, quoting, substitutions and heredoc bodies.

    This is a source lexer, not a Bash interpreter or runtime syntax checker.
    Every outer byte-range is partitioned into word/operator/comment/space/
    heredoc records; recursive command/process substitutions retain their
    own words and quote parts, with explicit overlap/layer metadata.
    """
    nodes=[];length=len(text)
    def emit(a,b,kind,layer,**extra):
        item={'start':a,'end':b,'kind':kind,'layer':layer};item.update(extra);nodes.append(item);return item
    def quoted(i,kind,layer):
        a=i;prefix=2 if kind=='ansi' else 1;i+=prefix;content=i
        while i<length:
            if kind!='single' and text[i]=='\\':i+=2;continue
            if kind=='double' and text.startswith('$(',i):i=expansion(i,layer);continue
            if kind=='double' and text.startswith('${',i):i=parameter(i,layer);continue
            if text[i]==('"' if kind=='double' else "'"):
                return i+1,{'start':a,'end':i+1,'quote':kind,'content_start':content,'content_end':i}
            i+=1
        raise AssertionError(('unterminated quote',a))
    def parameter(i,layer):
        a=i;i+=2;depth=1
        while i<length:
            if text[i]=='\\':i+=2;continue
            if text.startswith('$(',i):i=expansion(i,layer);continue
            if text.startswith('${',i):depth+=1;i+=2;continue
            if text[i]=='}':
                depth-=1
                if not depth:
                    i+=1;emit(a,i,'parameter',layer)
                    return i
            i+=1
        raise AssertionError(('unterminated parameter',a))
    def expansion(i,layer):
        a=i
        if text.startswith('$((',i):
            i+=3;depth=1
            while i<length:
                if text.startswith('$(',i):i=expansion(i,layer+1);continue
                if text[i]=='(':depth+=1;i+=1;continue
                if text.startswith('))',i) and depth==1:
                    i+=2;emit(a,i,'arithmetic',layer);return i
                if text[i]==')':depth-=1
                i+=1
            raise AssertionError(('unterminated arithmetic',a))
        i=code(i+2,')',layer+1)
        emit(a,i,'command-substitution' if text[a]=='$' else 'process-substitution',layer)
        return i
    def word(i,layer,regex=False):
        a=i;quotes=[]
        while i<length:
            c=text[i]
            if c.isspace():break
            if text.startswith('$(',i) or text.startswith('<(',i) or text.startswith('>(',i):i=expansion(i,layer);continue
            if text.startswith('${',i):i=parameter(i,layer);continue
            if text.startswith("$'",i):i,q=quoted(i,'ansi',layer);quotes.append(q);continue
            if c in "'\"":i,q=quoted(i,'single' if c=="'" else 'double',layer);quotes.append(q);continue
            if c=='\\':i+=2;continue
            if not regex and c in '|&;()<>{}':break
            i+=1
        assert i>a,('empty shell word',i)
        kind='continuation' if text[a:i].replace('\\\n','')=='' else 'regex-word' if regex else 'word'
        emit(a,i,kind,layer,quotes=quotes)
        return i
    def code(i,stop=None,layer=0):
        pending=[];delimiter=False;last_word=None;paren=0
        while i<length:
            c=text[i]
            if stop and c==stop and not paren:
                emit(i,i+1,'operator',layer);return i+1
            if c.isspace():
                a=i
                if c=='\n':
                    i+=1;emit(a,i,'space',layer)
                    for name,quoted_delimiter in pending:
                        start=i
                        while i<length:
                            end=text.find('\n',i);end=length if end<0 else end
                            if text[i:end]==name:
                                emit(start,i,'heredoc',layer,delimiter=name,quoted=quoted_delimiter)
                                emit(i,end+(end<length),'heredoc-end',layer,delimiter=name)
                                i=end+(end<length);break
                            i=end+(end<length)
                        else:raise AssertionError(('unterminated heredoc',name))
                    pending=[];last_word=None
                else:
                    while i<length and text[i].isspace() and text[i]!='\n':i+=1
                    emit(a,i,'space',layer)
                continue
            if i==0 and text.startswith('#!',i):
                end=text.find('\n',i);end=length if end<0 else end;emit(i,end,'hashbang',layer);i=end;continue
            if c=='#':
                end=text.find('\n',i);end=length if end<0 else end;emit(i,end,'comment',layer);i=end;continue
            if text.startswith(('$(','<(','>('),i):i=word(i,layer);last_word=None;continue
            if last_word=='=~':
                start=i;i=word(i,layer,True);last_word=text[start:i];continue
            if c in '|&;()<>{}':
                op=next((x for x in ('<<<','<<-','<<','>>','&&','||',';;','>&','<&','&>') if text.startswith(x,i)),c)
                emit(i,i+len(op),'operator',layer);i+=len(op)
                if op=='<<':delimiter=True
                if stop and op=='(':paren+=1
                elif stop and op==')':paren-=1
                last_word=None;continue
            start=i;i=word(i,layer);last_word=text[start:i]
            if delimiter:
                raw=text[start:i];name=raw.strip("'\"");pending.append((name,raw!=name));delimiter=False
        assert not stop,('unterminated shell substitution',stop)
        assert not pending
        return i
    code(0)
    # Only the outer layer is a complete disjoint source partition; nested
    # substitution records deliberately overlap the outer word that owns them.
    outer=sorted((n for n in nodes if n['layer']==0 and n['kind'] not in ('parameter','arithmetic','command-substitution','process-substitution')),key=lambda n:n['start'])
    at=0
    for n in outer:assert n['start']==at,('outer lexical gap/overlap',at,n);at=n['end']
    assert at==length
    return sorted(nodes,key=lambda n:(n['start'],n['end'],n['kind']))


def word_payload(text,node):
    a,b=node['start'],node['end'];quotes=node.get('quotes',[])
    if len(quotes)==1 and (quotes[0]['start'],quotes[0]['end'])==(a,b):
        q=quotes[0];value=text[q['content_start']:q['content_end']]
        if value:return q['content_start'],q['content_end'],value
    return a,b,text[a:b]


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
def decode_static(raw,source_start):
    """Decode fixed JS escapes with an exact character map; never evaluate ${}.

    A generated-source projection is only used to recognize nested literal
    boundaries. CSV English always retains the original raw source substring.
    Live interpolation stays unresolved, including its original source syntax.
    """
    chars=[];mapping=[];i=0
    simple={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','0':'\0'}
    while i<len(raw):
        start=i
        if raw[i]!='\\':
            value=raw[i];i+=1
        else:
            i+=1;assert i<len(raw)
            c=raw[i];i+=1
            if c=='\n':continue
            if c=='\r':
                if i<len(raw) and raw[i]=='\n':i+=1
                continue
            if c=='u':
                if raw[i:i+1]=='{':
                    end=raw.index('}',i+1);value=chr(int(raw[i+1:end],16));i=end+1
                else:value=chr(int(raw[i:i+4],16));i+=4
            elif c=='x':value=chr(int(raw[i:i+2],16));i+=2
            else:value=simple.get(c,c)
        chars.append(value);mapping.append((source_start+start,source_start+i))
    return ''.join(chars),mapping


def strip_yaml_comment(raw):
    quote=None;i=0
    while i<len(raw):
        c=raw[i]
        if quote:
            if c==quote:
                if quote=="'" and raw[i:i+2]=="''":i+=2;continue
                quote=None
            elif c=='\\' and quote=='"':i+=2;continue
        elif c in "'\"":quote=c
        elif c=='#' and (i==0 or raw[i-1].isspace()):return raw[:i].rstrip()
        i+=1
    return raw.rstrip()


@cache
def yaml_nodes(path):
    """Bounded authored YAML subset: every key/scalar and block; not a YAML evaluator."""
    text=read(path);lines=text.splitlines(keepends=True);starts=[];o=0
    for line in lines:starts.append(o);o+=len(line)
    out=[];stack=[];step_counts=Counter();i=0;flow_parent=None
    def scalar(a,b,keypath,kind='yaml-scalar',**meta):
        if a==b:return
        raw=text[a:b];quote=None
        if len(raw)>=2 and raw[0] in "'\"" and raw[-1]==raw[0]:quote=raw[0];a+=1;b-=1
        out.append(dict(start=a,end=b,kind=kind,keypath=keypath,quote=quote,english=text[a:b],**meta))
    while i<len(lines):
        raw=lines[i].rstrip('\r\n');trim=raw.lstrip();indent=len(raw)-len(trim)
        if not trim or trim.startswith('#'):i+=1;continue
        if flow_parent is not None:
            val=strip_yaml_comment(trim)
            if val in ('[',']','],'):i+=1;continue
            if indent>flow_parent[0]:
                val=val.rstrip(',');a=starts[i]+raw.index(trim);scalar(a,a+len(val),flow_parent[1]+['item'],'yaml-flow-item');i+=1;continue
            flow_parent=None
        entry=trim.startswith('- ');content=trim[2:] if entry else trim;content_start=starts[i]+indent+(2 if entry else 0)
        effective=indent+2 if entry else indent
        if entry:
            while stack and stack[-1][0]>=indent:stack.pop()
            parent=stack[-1][1] if stack else []
            if parent and (parent[-1]=='steps' or re.match(r'[A-Za-z_][A-Za-z0-9_-]*:(?:\s|$)',content)):
                token=tuple(parent);idx=step_counts[token];step_counts[token]+=1;parent=parent+[idx];stack.append((indent,parent))
            else:
                val=strip_yaml_comment(content);scalar(content_start,content_start+len(val),parent+['item'],'yaml-sequence-item');i+=1;continue
        while stack and stack[-1][0]>=effective:stack.pop()
        parent=stack[-1][1] if stack else []
        match=re.match(r'([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)',content)
        if not match:
            assert trim in ('[',']','],') or trim.endswith(','),(path,i+1,trim)
            if trim=='[':flow_parent=(indent,parent)
            i+=1;continue
        key=match[1];keypath=parent+[key]
        out.append(dict(start=content_start,end=content_start+len(key),kind='yaml-key',keypath=keypath,quote=None,english=key))
        after=content[match.end():];leading=len(after)-len(after.lstrip());value=strip_yaml_comment(after.lstrip());a=content_start+match.end()+leading
        if value in ('|','|-','|+'):
            j=i+1
            while j<len(lines):
                r=lines[j].rstrip('\r\n');t=r.lstrip();ind=len(r)-len(t)
                if t and ind<=effective:break
                j+=1
            bs=starts[i+1] if i+1<len(lines) else len(text);be=starts[j] if j<len(lines) else len(text)
            out.append(dict(start=bs,end=be,kind='yaml-block',keypath=keypath,quote=None,english=text[bs:be],indicator=value,header_start=a,header_end=a+len(value)))
            i=j;continue
        if value:
            if value.startswith('[') and value.endswith(']'):
                # Flow scalar list: quotes/commas inside expressions never evaluated.
                begin=a+1;end=a+len(value)-1;k=begin;item=begin;quote=None
                while k<=end:
                    char=text[k] if k<end else ','
                    if quote:
                        if char==quote:quote=None
                        elif char=='\\' and quote=='"':k+=1
                    elif char in "'\"":quote=char
                    elif char==',':
                        x=item;y=k
                        while x<y and text[x].isspace():x+=1
                        while y>x and text[y-1].isspace():y-=1
                        scalar(x,y,keypath+['item'],'yaml-flow-item');item=k+1
                    k+=1
            else:scalar(a,a+len(value),keypath)
        else:stack.append((effective,keypath))
        i+=1
    return sorted(out,key=lambda n:(n['start'],n['end'],n['kind']))


def projection(path,a,b):
    raw=read(path)[a:b];lines=raw.splitlines(keepends=True)
    indent=min((len(x)-len(x.lstrip(' ')) for x in lines if x.strip()),default=0)
    chars=[];mapping=[];offset=a
    for line in lines:
        take=min(indent,len(line)-len(line.lstrip(' ')))
        for i,c in enumerate(line[take:],take):chars.append(c);mapping.append((offset+i,offset+i+1))
        offset+=len(line)
    return ''.join(chars),mapping


@cache
def ps_lex(source):
    """Lossless PowerShell source words/quotes, comments, operators and whitespace."""
    out=[];i=0
    def emit(a,b,k,quote=None):out.append(dict(start=a,end=b,kind=k,quote=quote))
    while i<len(source):
        a=i;c=source[i]
        if c.isspace():
            i+=1
            while i<len(source) and source[i].isspace():i+=1
            emit(a,i,'space');continue
        if c=='#':
            i=source.find('\n',i);i=len(source) if i<0 else i;emit(a,i,'comment');continue
        if c in "'\"":
            quote=c;i+=1
            while i<len(source):
                if quote=='"' and source[i]=='`':i+=2;continue
                if source[i]==quote:
                    if source[i:i+2]==quote*2:i+=2;continue
                    i+=1;break
                i+=1
            else:raise AssertionError(('PowerShell unterminated quote',a))
            emit(a,i,'string',quote);continue
        if c in '(){}[];,|><=&':
            i+=1;emit(a,i,'operator');continue
        i+=1
        while i<len(source) and not source[i].isspace() and source[i] not in "'\"(){}[];,|><=&#":i+=1
        emit(a,i,'word')
    assert ''.join(source[n['start']:n['end']] for n in out)==source
    return out


@cache
def contexts(path):
    nodes=yaml_nodes(path);jobs={};steps={}
    for n in nodes:
        kp=n['keypath']
        if len(kp)>=2 and kp[0]=='jobs':
            job=kp[1];jobs.setdefault(job,[]).append(n)
            if len(kp)>=4 and kp[2]=='steps' and isinstance(kp[3],int):steps.setdefault((job,kp[3]),[]).append(n)
    return jobs,steps


def context_for(path,node):
    kp=node['keypath'];jobs,steps=contexts(path)
    if not kp or kp[0]!='jobs' or len(kp)<2:return dict(job=None,step=None,job_fields={},step_fields={})
    job=kp[1];fields=lambda ns,prefix:{n['keypath'][-1]:n['english'] for n in ns if n['kind']!='yaml-key' and len(n['keypath'])==prefix}
    step=kp[3] if len(kp)>=4 and kp[2]=='steps' and isinstance(kp[3],int) else None
    return dict(job=job,step=step,job_fields=fields(jobs[job],3),step_fields=fields(steps.get((job,step),[]),5))


@cache
def runs(path):
    result=[]
    for n in yaml_nodes(path):
        if n['keypath'][-1]!='run' or n['kind']=='yaml-key':continue
        ctx=context_for(path,n);shell=ctx['step_fields'].get('shell')
        if shell is None:
            job=ctx['job'];ns=contexts(path)[0][job]
            shell=next((r['english'] for r in ns if r['kind']!='yaml-key' and r['keypath']==['jobs',job,'defaults','run','shell']),None)
        if shell is None:
            runner=ctx['job_fields'].get('runs-on','')
            if 'container' in ctx['job_fields']:shell='sh (container default)'
            elif runner.startswith('windows-'):shell='pwsh (Windows default)'
            elif runner.startswith(('ubuntu-','macos-')):shell='bash (host default)'
            else:shell='portable-default-command (matrix pwsh/bash)'
        code,mapping=projection(path,n['start'],n['end']) if n['kind']=='yaml-block' else (n['english'],[(i,i+1) for i in range(n['start'],n['end'])])
        result.append(dict(node=n,context=ctx,shell=shell,code=code,mapping=mapping))
    return result


def source_part(run,a,b,kind,**extra):
    mapping=run['mapping'];assert 0<=a<b<=len(mapping)
    x,y=mapping[a][0],mapping[b-1][1]
    return dict(start=x,end=y,kind=kind,parent_start=run['node']['start'],parent_end=run['node']['end'],projected_start=a,projected_end=b,shell=run['shell'],keypath=run['node']['keypath'],**extra)


@cache
def run_parts(path):
    result=[]
    for run in runs(path):
        code=run['code'];shell=run['shell'];js_sources=[];py_sources=[]
        if shell.startswith('pwsh'):
            ns=ps_lex(code)
            for n in ns:
                if n['kind'] not in ('word','string'):continue
                a,b=n['start'],n['end']
                if n['kind']=='string':a+=1;b-=1
                if a==b:continue
                result.append(source_part(run,a,b,'powershell-'+n['kind'],quote=n['quote']))
                if n['kind']=='string' and re.search(r'(?:-e|-p)\s*$',code[:n['start']]):js_sources.append((a,b,'powershell-node-argument'))
        elif shell.startswith('portable-'):
            # All matrix-default commands in these pinned files are common bare
            # command words, with no quoting/control syntax. Default host differs.
            assert not re.search(r'[\"\'`$;|<>{}()]',code),(path,run['node']['start'])
            for m in re.finditer(r'\S+',code):result.append(source_part(run,m.start(),m.end(),'portable-command-word'))
        else:
            ns=shell_lex(code)
            for n in ns:
                if n['kind'] in ('word','regex-word'):
                    a,b,raw=word_payload(code,n)
                    result.append(source_part(run,a,b,'shell-word',layer=n['layer'],word_kind=n['kind'],word_start=n['start'],word_end=n['end']))
                    qs=n.get('quotes',[])
                    if not (len(qs)==1 and qs[0]['start']==n['start'] and qs[0]['end']==n['end']):
                        for q in qs:
                            x,y=q['content_start'],q['content_end']
                            if x<y:result.append(source_part(run,x,y,'shell-quote-part',layer=n['layer'],quote=q['quote'],word_start=n['start'],word_end=n['end']))
                    if len(qs)==1 and qs[0]['start']==n['start'] and qs[0]['end']==n['end'] and re.search(r'(?:-e|-p)\s*$',code[:n['start']]):js_sources.append((a,b,'bash-node-argument'))
                elif n['kind']=='heredoc':
                    a,b=n['start'],n['end'];result.append(source_part(run,a,b,'shell-heredoc',delimiter=n['delimiter'],quoted=n['quoted']))
                    if n['delimiter']=='PY':py_sources.append((a,b))
        for a,b,site in js_sources:
            src=code[a:b]
            for x,y,k,raw in lex(src):
                if k not in ('string','template','regex','hashbang') or not raw:continue
                lo,hi=(x,y) if k in ('regex','hashbang') else (x+1,y-1)
                result.append(source_part(run,a+lo,a+hi,'javascript-'+k,source_site=site,js_parent_start=a,js_parent_end=b))
        for a,b in py_sources:
            src=code[a:b];ls=src.splitlines(keepends=True);offsets=[0]
            for line in ls:offsets.append(offsets[-1]+len(line))
            for tok in tokenize.generate_tokens(io.StringIO(src).readline):
                if tok.type!=tokenize.STRING:continue
                start=offsets[tok.start[0]-1]+tok.start[1];end=offsets[tok.end[0]-1]+tok.end[1]
                match=re.match(r'(?i)([rubf]*)(\"\"\"|\x27\x27\x27|\"|\x27)',tok.string);assert match
                prefix,quote=match.groups();lo=start+len(prefix)+len(quote);hi=end-len(quote)
                if lo<hi:result.append(source_part(run,a+lo,a+hi,'python-string',prefix=prefix,quote=quote,python_parent_start=a,python_parent_end=b))
    return sorted(result,key=lambda n:(n['start'],n['end'],n['kind']))


@cache
def expressions(path):
    return [dict(start=m.start(),end=m.end(),kind='workflow-expression',english=m.group()) for m in re.finditer(r'\$\{\{.*?}}',read(path),re.S)]


def yaml_coverage(path):
    """Every noncomment/nonblank character: data/key/block or YAML punctuation."""
    text=read(path);covered=[False]*len(text)
    for n in yaml_nodes(path):
        for i in range(n['start'],n['end']):covered[i]=True
        if n['kind']=='yaml-block':
            for i in range(n['header_start'],n['header_end']):covered[i]=True
        if n.get('quote'):
            assert text[n['start']-1]==n['quote']==text[n['end']]
            covered[n['start']-1]=covered[n['end']]=True
    offset=0
    for line in text.splitlines(keepends=True):
        cut=strip_yaml_comment(line.rstrip('\r\n'))
        # Only mask comments not already inside a scalar/block.
        for i in range(len(cut),len(line)):
            if line[i] not in '\r\n' and not covered[offset+i]:covered[offset+i]=True
        offset+=len(line)
    leftovers=[(i,c) for i,c in enumerate(text) if not covered[i] and not c.isspace() and c not in ':,[]{}-']
    assert not leftovers,(path,[(text.count('\n',0,i)+1,c) for i,c in leftovers[:10]])
    return sum(covered)


SOURCE_BLOBS={'.github/workflows/ci.yml': 'd71eb3f9005d0eb16d7a392d843b22a524ef5b25',
 '.github/workflows/launcher-checks.yml': '040b115fb3287e7a5d21161f3e0fba25386ebe24',
 '.github/workflows/launcher-feed-guard.yml': 'e9722207b57f9f6133b920247701e1118657c889',
 '.github/workflows/launcher-recipe.yml': '60ccaf4f3e756491f47c8ab9eb14b1f5e5542257',
 '.github/workflows/launcher-runtime.yml': 'd19218831abdc3345855c5e7e352fe2cf7dd8871',
 '.github/workflows/pi-latest.yml': '0b385b47c8cb9253560b97c5335fc776ae641879',
 '.github/workflows/publish-npm.yml': 'e6135055e72b7eb35c4f469dc36e3ed144a2bba1',
 '.github/workflows/publish-pypi.yml': 'ec6588813ab247d40ab418162989fcb56b05fb57',
 '.github/workflows/test-benchmark.yml': '80a4e1856e95c8668686bb65bdcdde8349586b6c',
 '.github/workflows/textguard-native.yml': '48229c44c1a618d6a03c26cc58bf3bf36a226539'}
TABLE_HASHES={'ci-text-scope.csv': '76a8073bb1c68f09f20710bd0efdbbdd1165375571abd3368b6d3f8b85cbe64c',
 'ci-text.csv': '6b22faeef63fe079b471fed9c104fc543c39f0552780ba1ec49593f4e6979bf0'}
EXPECTED={'.github/workflows/ci.yml': {'coverage': 26026,
                              'expressions': 112,
                              'lines': 719,
                              'parts': 355,
                              'runs': 60,
                              'yaml': 1128},
 '.github/workflows/launcher-checks.yml': {'coverage': 2013,
                                           'expressions': 1,
                                           'lines': 65,
                                           'parts': 96,
                                           'runs': 8,
                                           'yaml': 78},
 '.github/workflows/launcher-feed-guard.yml': {'coverage': 1268,
                                               'expressions': 3,
                                               'lines': 37,
                                               'parts': 35,
                                               'runs': 2,
                                               'yaml': 47},
 '.github/workflows/launcher-recipe.yml': {'coverage': 5804,
                                           'expressions': 12,
                                           'lines': 128,
                                           'parts': 193,
                                           'runs': 7,
                                           'yaml': 142},
 '.github/workflows/launcher-runtime.yml': {'coverage': 9852,
                                            'expressions': 37,
                                            'lines': 233,
                                            'parts': 292,
                                            'runs': 11,
                                            'yaml': 278},
 '.github/workflows/pi-latest.yml': {'coverage': 724,
                                     'expressions': 0,
                                     'lines': 35,
                                     'parts': 10,
                                     'runs': 2,
                                     'yaml': 42},
 '.github/workflows/publish-npm.yml': {'coverage': 5826,
                                       'expressions': 20,
                                       'lines': 147,
                                       'parts': 152,
                                       'runs': 5,
                                       'yaml': 193},
 '.github/workflows/publish-pypi.yml': {'coverage': 1333,
                                        'expressions': 1,
                                        'lines': 54,
                                        'parts': 20,
                                        'runs': 3,
                                        'yaml': 71},
 '.github/workflows/test-benchmark.yml': {'coverage': 1927,
                                          'expressions': 14,
                                          'lines': 69,
                                          'parts': 20,
                                          'runs': 3,
                                          'yaml': 107},
 '.github/workflows/textguard-native.yml': {'coverage': 1632,
                                            'expressions': 1,
                                            'lines': 58,
                                            'parts': 27,
                                            'runs': 5,
                                            'yaml': 81}}

FIXED_INLINE={
('.github/workflows/ci.yml',716,'javascript-template'):1,
('.github/workflows/launcher-checks.yml',61,'powershell-string'):1,
('.github/workflows/launcher-feed-guard.yml',33,'shell-quote-part'):1,
('.github/workflows/launcher-feed-guard.yml',36,'shell-word'):1,
('.github/workflows/launcher-recipe.yml',55,'powershell-string'):1,
('.github/workflows/launcher-recipe.yml',77,'powershell-string'):1,
('.github/workflows/launcher-recipe.yml',123,'powershell-string'):2,
('.github/workflows/launcher-runtime.yml',57,'shell-word'):1,
('.github/workflows/launcher-runtime.yml',86,'powershell-string'):1,
('.github/workflows/launcher-runtime.yml',115,'powershell-string'):1,
('.github/workflows/launcher-runtime.yml',120,'powershell-string'):1,
('.github/workflows/pi-latest.yml',32,'shell-word'):1,
('.github/workflows/pi-latest.yml',34,'shell-word'):1,
('.github/workflows/publish-npm.yml',98,'shell-word'):1,
('.github/workflows/publish-pypi.yml',31,'python-string'):1}


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as file:
        reader=csv.DictReader(file);assert reader.fieldnames==columns;return list(reader)


def bounded_context(path,n):
    c=context_for(path,n);c['step_fields']={k:val for k,val in c['step_fields'].items() if k!='run'};return c


def main():
    for name,digest in TABLE_HASHES.items():assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('ci-text.csv',COLUMNS);scope=table('ci-text-scope.csv',SCOPE_COLUMNS)
    assert len(rows)==3754 and len(scope)==14 and len({r['source'] for r in scope})==14
    assert all(r['revision']==REVISION for r in scope)
    full=[r for r in scope if r['status']=='fully-read-ci-yaml']
    assert len(full)==10 and {r['source'] for r in full}==set(FILES)==set(SOURCE_BLOBS)
    assert not any(r['sha256'] for r in scope if r['status']!='fully-read-ci-yaml')
    for row in full:
        raw=(ROOT/row['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==row['sha256'],row['source']
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==SOURCE_BLOBS[row['source']],row['source']
    census=table('source-census.csv',['path','git_mode','git_blob','path_category','scope_reference_status','scope_records_json'])
    assert json.loads((HERE/'source-census-snapshot.json').read_text(encoding='utf-8'))['source_pin']==REVISION
    assert {r['path'] for r in census if r['path_category']=='ci-workflow'}==set(FILES)
    assert all(next(r for r in census if r['path']==p)['git_blob']==SOURCE_BLOBS[p] for p in FILES)
    yaml_expected={};parts_expected={};expression_expected={};runs_expected={};uses_expected={}
    for path in FILES:
        ns=yaml_nodes(path);rs=runs(path);ps=run_parts(path);es=expressions(path)
        assert EXPECTED[path]=={'lines':len(read(path).splitlines()),'yaml':len(ns),'runs':len(rs),'parts':len(ps),'expressions':len(es),'coverage':yaml_coverage(path)}
        for n in ns:
            key=(path,n['start'],n['end'],n['kind']);assert key not in yaml_expected;yaml_expected[key]=n
            if n['kind']!='yaml-key' and n['keypath'][-1]=='uses':uses_expected[(path,n['start'],n['end'])]=n
        for n in ps:
            key=(path,n['start'],n['end'],n['kind']);assert key not in parts_expected;parts_expected[key]=n
        for n in es:expression_expected[(path,n['start'],n['end'],n['kind'])]=n
        for r in rs:runs_expected[(path,r['node']['start'],r['node']['end'])]=r
    assert sum(x['lines'] for x in EXPECTED.values())==1545
    assert len(yaml_expected)==2167 and len(parts_expected)==1200 and len(expression_expected)==201
    assert len(runs_expected)==106 and len(uses_expected)==79
    yaml_seen=set();parts_seen=set();expressions_seen=set();runs_seen=set();uses_seen=set();assertions=[];roles=Counter();kinds=Counter();fixed_inline=Counter()

    for index,row in enumerate(rows,1):
        assert row['item_id']==f'CI-TEXT-{index:04d}' and row['message_id']==''
        assert all(row[c] for c in COLUMNS if c not in ('english','message_id'))
        ev=json.loads(row['evidence']);path=ev['path'];assert path in FILES
        text=read(path);a,b=ev['start'],ev['end'];assert 0<=a<=b<=len(text)
        line=text.count('\n',0,a)+1;assert row['english_location']==f'{path}:{line}'
        assert row['translation_boundary'].startswith(ev['role']+'. ')
        roles[ev['role']]+=1;kinds[ev['kind']]+=1;key=(path,a,b,ev['kind'])
        if ev['kind'].startswith('yaml-'):
            assert key in yaml_expected and key not in yaml_seen;yaml_seen.add(key);n=yaml_expected[key]
            assert row['english']==n['english']==text[a:b]
            for k,value in n.items():
                if k not in ('start','end','english','kind'):assert ev[k]==value,(row['item_id'],k)
            assert ev['context']==bounded_context(path,n)
            if a==b:assert n['kind']=='yaml-scalar' and n['quote']=="'" and row['english']==''
        elif key in parts_expected:
            assert key not in parts_seen;parts_seen.add(key);n=parts_expected[key]
            assert row['english']==text[a:b] and a<b
            for k,value in n.items():
                if k not in ('start','end','kind'):assert ev[k]==value,(row['item_id'],k)
            run=runs_expected[(path,n['parent_start'],n['parent_end'])]
            assert ev['context']==bounded_context(path,run['node'])
            if ev['role'].startswith('fixed-'):fixed_inline[(path,line,ev['kind'])]+=1
        elif ev['kind']=='workflow-expression':
            assert key in expression_expected and key not in expressions_seen;expressions_seen.add(key)
            assert row['english']==text[a:b]==expression_expected[key]['english']
            assert row['english'].startswith('${{') and row['english'].endswith('}}')
            owner=next(n for n in yaml_nodes(path) if n['kind']!='yaml-key' and n['start']<=a<b<=n['end'])
            assert (ev['owner_start'],ev['owner_end'])==(owner['start'],owner['end']) and ev['keypath']==owner['keypath']
            assert ev['context']==bounded_context(path,owner)
        elif ev['kind']=='run-delivery-boundary':
            k=(path,a,b);assert k in runs_expected and k not in runs_seen;runs_seen.add(k);r=runs_expected[k]
            assert row['english']=='' and ev['role']=='delegated-run-streams' and ev['shell']==r['shell']
            assert ev['context']==bounded_context(path,r['node']) and ev['keypath']==r['node']['keypath']
        elif ev['kind']=='action-delivery-boundary':
            k=(path,a,b);assert k in uses_expected and k not in uses_seen;uses_seen.add(k);n=uses_expected[k]
            assert row['english']=='' and ev['action_reference']==n['english']
            local=n['english'].startswith('./.github/workflows/')
            assert ev['role']==('reusable-workflow-boundary' if local else 'external-action-boundary')
            assert ev['context']==bounded_context(path,n)
            if local:assert n['english'][2:] in FILES
            else:assert re.fullmatch(r'[^@]+@[0-9a-f]{40}',n['english']),n['english']
        else:
            assert ev['kind']=='native-assertion-boundary' and row['english']==''
            assertions.append(row);assert ev['assertion']=='assert.equal' and ev['message_argument']=='omitted'
            start=text.index('assert.equal(');end=text.index(';',start)+1;assert (a,b)==(start,end)
    assert yaml_seen==set(yaml_expected) and parts_seen==set(parts_expected) and expressions_seen==set(expression_expected)
    assert runs_seen==set(runs_expected) and uses_seen==set(uses_expected) and len(assertions)==1
    assert fixed_inline==Counter(FIXED_INLINE) and sum(fixed_inline.values())==16
    assert roles['fixed-workflow-label']==10 and roles['fixed-step-label']==98 and roles['fixed-input-description']==24
    assert roles['protected-assertion-expected-value']==1 and roles['reusable-workflow-boundary']==2 and roles['external-action-boundary']==77
    assert sum(r['english']=='' and json.loads(r['evidence'])['kind']=='yaml-scalar' for r in rows)==2
    # Exact authored guard/sink postconditions; external tooling is never invoked.
    guards={
        '.github/workflows/ci.yml':['group: ci-${{ github.ref }}-${{ github.event_name == \'pull_request\' && \'pr\' || github.sha }}','node scripts/ci-changes.mjs "$files" "$LABELS" >> "$GITHUB_OUTPUT"','JOUZU_TEST_TIMINGS_JOB=node (${{ matrix.os }}, ${{ matrix.node }})','node: ["22.23.4"]','result === "success" || (result === "skipped" && (job === "changes" || process.env.PARTIAL === "true"))','if (failed.length) {','console.error(`Not passed: ${failed.map(([job, result]) => `${job} (${result})`).join(", ")}`);'],
        '.github/workflows/launcher-checks.yml':["if (-not $ready) { throw 'Vite did not become ready' }",'catch { Start-Sleep 1 }','finally { if (-not $vite.HasExited) { Stop-Process -Id $vite.Id } }'],
        '.github/workflows/launcher-feed-guard.yml':['if: failure()', 'if [ "$existing" = "0" ]; then','--body "The signed update feed does not match the version published on npm. Run the update recipe for the published version."'],
        '.github/workflows/launcher-recipe.yml':['if: ${{ inputs.publish }}','*> $null',"--title 'Jouzu update feed' --notes 'Signed Jouzu update recipes.'",'finally { Remove-Item $key -Force -ErrorAction SilentlyContinue }'],
        '.github/workflows/launcher-runtime.yml':['echo "::error::Missing release configuration: $name"; missing=1','exit "$missing"','if: inputs.runtime_run_id != github.run_id','if: inputs.runtime_run_id == github.run_id','"jouzu_version=$version" | Out-File $env:GITHUB_OUTPUT -Append','if: ${{ !inputs.publish }}'],
        '.github/workflows/pi-latest.yml':['if: failure()', '>> "$GITHUB_STEP_SUMMARY"'],
        '.github/workflows/publish-npm.yml':['echo "Native Windows qualification is required before publication" >&2; exit 1;','uses: ./.github/workflows/launcher-recipe.yml','uses: ./.github/workflows/launcher-runtime.yml'],
        '.github/workflows/publish-pypi.yml':['python - <<\'PY\'','if version == "0.0.1":','raise SystemExit("PyPI 0.0.1 is a reservation and must not be republished for the npm-only v0.1 release")'],
    }
    for path,fragments in guards.items():
        for fragment in fragments:assert fragment in read(path),(path,fragment)
    assert sum(p['kind']=='python-string' for path in FILES for p in run_parts(path))==4
    assert sum(p['kind'].startswith('javascript-') for path in FILES for p in run_parts(path))==33
    assert sum(p['kind']=='shell-heredoc' and p['delimiter']=='PY' and p['quoted'] for path in FILES for p in run_parts(path))==1
    for name in TABLE_HASHES:
        assert not any(line.rstrip()!=line for line in (HERE/name).read_text(encoding='utf-8').splitlines()),name
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text(encoding='utf-8').splitlines())
    print('PASS ci-text:3754rows=2167YAML+1200inline+201expressions+186boundaries;10bodies/1545lines/10SHA256+main-blob identities;16inline prose+132metadata labels/descriptions. No workflow/child/native execution or secret-value reads.')


if __name__=='__main__':main()
