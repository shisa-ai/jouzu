"""Read-only Bash/embedded source inventory; never launches Bash, Git or Node."""
import csv,hashlib,json,re
from functools import cache
from pathlib import Path
from collections import Counter
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
SOURCE='dev-build.sh'
COLUMNS=['item_id','message_id','english','english_location','display_location','trigger','consumer_evidence','translation_boundary','evidence']
SCOPE_COLUMNS=['source','status','coverage','sha256','revision','detail']


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


def printf_projection(raw,start):
    """Interpret fixed printf backslash escapes only; never %q or variables."""
    chars=[];mapping=[];i=0
    simple={'n':'\n','t':'\t','r':'\r','\\':'\\'}
    while i<len(raw):
        a=i
        if raw[i]=='\\' and i+1<len(raw) and raw[i+1] in simple:value=simple[raw[i+1]];i+=2
        else:value=raw[i];i+=1
        chars.append(value);mapping.append((start+a,start+i))
    return ''.join(chars),mapping


@cache
def js_lex(source):
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
def inventory_parts():
    text=read(SOURCE);nodes=shell_lex(text);result=[]
    words=[n for n in nodes if n['kind'] in ('word','regex-word')]
    for n in words:
        a,b,value=word_payload(text,n)
        result.append({'kind':'shell-word','start':a,'end':b,'english':value,'word_start':n['start'],'word_end':n['end'],'layer':n['layer'],'word_kind':n['kind']})
        for q in n['quotes']:
            if (q['start'],q['end'])==(n['start'],n['end']):continue
            a,b=q['content_start'],q['content_end']
            if a==b:continue
            result.append({'kind':'quoted-part','start':a,'end':b,'english':text[a:b],'word_start':n['start'],'word_end':n['end'],'quote':q['quote'],'layer':n['layer']})
    for n in nodes:
        a,b=n['start'],n['end']
        if n['kind']=='hashbang':result.append({'kind':'hashbang','start':a,'end':b,'english':text[a:b]})
        elif n['kind']=='heredoc':result.append({'kind':'heredoc','start':a,'end':b,'english':text[a:b],'delimiter':n['delimiter'],'quoted':n['quoted']})
        elif n['kind']=='parameter':
            match=re.match(r'\$\{([^{}]*?)(:-)(.*)\}$',text[a:b],re.S)
            if match and match[3]:
                x=a+match.start(3);y=a+match.end(3)
                result.append({'kind':'parameter-default','start':x,'end':y,'english':text[x:y],'parameter_start':a,'parameter_end':b,'parameter':match[1]})
    # Explicit JavaScript stdin/-e/-p source, quoted literally by the shell.
    js_sources=[]
    for n in nodes:
        if n['kind']=='heredoc' and n['delimiter']=='NODE':js_sources.append((n['start'],n['end'],'stdin-heredoc'))
    for n in words:
        a,b,value=word_payload(text,n);line=text.count('\n',0,a)+1
        if line in (67,262,529) and (value.startswith('const [major, minor]') or value.startswith('process.stdout.write(') or value.startswith('require(')):
            js_sources.append((a,b,'inline-node-source'))
    for pa,pb,site in js_sources:
        projection=text[pa:pb]
        for a,b,kind,value in js_lex(projection):
            if kind not in ('string','template','regex','hashbang') or not value:continue
            x,y=(pa+a,pa+b) if kind in ('regex','hashbang') else (pa+a+1,pa+b-1)
            result.append({'kind':'javascript-token','start':x,'end':y,'english':text[x:y],'token_kind':kind,'parent_start':pa,'parent_end':pb,'source_site':site})
    # printf fragments become source in generated hook files. %q substitutions
    # remain unresolved; only known backslash escapes are projected.
    for n in words:
        pa,pb,raw=word_payload(text,n);line=text.count('\n',0,pa)+1
        if line not in (536,537,538,539,540,541) or not raw.endswith('\\n'):continue
        projection,mapping=printf_projection(raw,pa)
        for child in shell_lex(projection):
            if child['kind'] not in ('word','regex-word'):continue
            a,b,value=word_payload(projection,child)
            x,y=mapping[a][0],mapping[b-1][1]
            result.append({'kind':'generated-hook-word','start':x,'end':y,'english':text[x:y],'parent_start':pa,'parent_end':pb,'projected_start':a,'projected_end':b,'projected_payload':value,'layer':child['layer']})
    return sorted(result,key=lambda r:(r['start'],r['end'],r['kind']))


@cache
def function_ranges():
    text=read(SOURCE);bodies=[n for n in shell_lex(text) if n['kind']=='heredoc'];result=[]
    for match in re.finditer(r'^([a-z_]+)\(\) \{\n',text,re.M):
        end=next(m.start() for m in re.finditer(r'^}\s*$',text[match.end():],re.M) if not any(n['start']<=match.end()+m.start()<n['end'] for n in bodies))+match.end()
        result.append((match.start(),end,match[1],text.count('\n',0,match.start())+1))
    return result


def function_at(a,b):
    return next(({'name':name,'line':line,'start':start,'end':end} for start,end,name,line in function_ranges() if start<=a<b<=end),None)


SOURCE_BLOBS={'.github/workflows/ci.yml': 'd71eb3f9005d0eb16d7a392d843b22a524ef5b25',
 '.github/workflows/pi-latest.yml': '0b385b47c8cb9253560b97c5335fc776ae641879',
 'dev-build.sh': '753d08e21b60dcfc30bf35751ed812d53f860bbc',
 'package-lock.json': 'b71bc0c61af4a1f4fe2b6abb986f1b9313ea46d4',
 'package.json': 'fd9d38ea561c0aa8202eb236b8a5807b4e90c339',
 'packages/cli/package.json': 'c11f4b56d2a09d45c47d22d87d8c45641865d9bc',
 'packages/cli/release-extensions.json': 'd13b52557fd1095f878f1a729314e91e48ede531',
 'packages/cli/src/camoufox-adapter.ts': '5fc2c720e584d9e6014f0394a1b780581608d86f',
 'packages/cli/src/textguard-native.ts': 'd0b1eaa68a385c28eee47f497296cafdb257ea88',
 'packages/cli/src/updater.ts': '2408a7434538c5e4e0451d3f1e918ec1920b2c3d',
 'packages/session-ui/package.json': 'b54dc2ff1f10b29c5058b1e115608c76bbb7f72b',
 'scripts/affected-tests.mjs': 'e35645fa9766b14e3099248d03d6df652b489e44',
 'scripts/affected-tests.test.mjs': '43fb0da2418107a20258a00ec21d3798d0061570',
 'scripts/apply-background-flow.mjs': '66e208332a09325693d85196234686d34142e16b',
 'scripts/apply-code-previews.mjs': '5c63b302622583cde7d4388714ba6b5982245209',
 'scripts/apply-multiloop-wait-skill.mjs': '8654d411d56eedaef8658d138708bf0ce68f6e34',
 'scripts/apply-pi-content-policy.mjs': '6f83cc040e2c272a4ab44aa12bb2513783b6eec7',
 'scripts/apply-pi-flow-control.mjs': '97298d0c397341af10b3a3b7d01baafcd8fa32ab',
 'scripts/apply-pi-path-utils.mjs': 'b0ed2028e4bf8a8140d6593ea29627f4ebfc2a0f',
 'scripts/apply-pi-provider-receipts.mjs': 'a68cd4c0830d0c8e9bd737723cd6975c8017377f',
 'scripts/apply-pi-terminal-clipboard.mjs': '5d43eeab7df69789f603775c12331dfb53947c2e',
 'scripts/apply-task-flow.mjs': '6032feb92cd450428d4d319286edc47df2a3c5f9',
 'scripts/apply-vcc-goals.mjs': 'a1a949eb91e3b07069b327ac7ab34a77997f67b6',
 'scripts/apply-webaio-defuddle-quiet.mjs': '480ddd49c7db55eae4d742765fda5040319adf99',
 'scripts/apply-webaio-defuddle-quiet.test.mjs': '2190df6632266b1839ab77a6397c593f0792a014',
 'scripts/audit-ja-startup.mjs': '62eaa03ee54ec7bb1c8cb8255aaa56e242a699c7',
 'scripts/background-flow-transform.mjs': '3a3342cac064bac029346b6f78161b77b8c5cba7',
 'scripts/background-resource-transform.mjs': 'f4586e78b45c010ebe96977eec20b1e9af971603',
 'scripts/background-widget-transform.mjs': '1146fba546d0b62b1f12ea506b55137245dbaf7a',
 'scripts/build-textguard.mjs': '1919cabf42d91b0d6eab028deaf734c3bc608475',
 'scripts/canvas-package-boundary.mjs': '7c077b84dff539d2d577bb6c7a4e11574abee990',
 'scripts/canvas-package-boundary.test.mjs': '5aa97df57ea71de9146ab9d96125d3a21d72e81d',
 'scripts/catalog-digest.mjs': '7140a852a5fa93d13c2d5600dcca1b55b826ef40',
 'scripts/catalog-lock.mjs': '99b35759530b162f70f3e4ccfaa15f141b149c62',
 'scripts/check-direct-strings.mjs': '98de12e8d0605dbb6037d788d63d7cb54b16d2a8',
 'scripts/check-dist-fresh.mjs': '2941886717ab8ce7e7d745cb3f015e95b3629eb8',
 'scripts/check-locales.mjs': '218d7b17b97d6c222fce2acf6191a06267092d5c',
 'scripts/check-pi-contract.mjs': '9c38f26c85cb0e172e67f53267506b9268288dca',
 'scripts/check-release-metadata.mjs': '7d26a067bbc477c0966ac67c1454fb73e0f52b26',
 'scripts/check-release-metadata.test.mjs': 'db7f3334f864c8f2db1d4370a094095fe4d5145f',
 'scripts/ci-changes.mjs': '9bf55cf2cdb86afb2d1e5edc3f476cd91114848a',
 'scripts/ci-changes.test.mjs': '693a3d826a426ac153cf8b966de79af1d4a87377',
 'scripts/cjk-catalog-render.mjs': 'ee2dc60dcb35a984de92f89e8455bf4729ed3176',
 'scripts/code-previews-transform.mjs': '752aecea2a30ab1778c233aa24ca0e62fffb3d23',
 'scripts/code-previews.test.mjs': '34081335c39da6a7905c13cfe75c457b2f370512',
 'scripts/configure-release-packlists.mjs': 'bcbb9f725dcda52275e25cc735148af7e065cc34',
 'scripts/copy-catalog.mjs': '67380aa1edc4e913047607bcc26183704d0d88a1',
 'scripts/copy-locales.mjs': '46c5849d81a4928541884ec1d59cc16b8bb8065a',
 'scripts/copy-pi-lock.mjs': 'b86f2537d792c4c66ba0924f675f34b063fb87b4',
 'scripts/copy-profiles.mjs': '2d4ce2236339d673104069bc7d1bfb717e8240bc',
 'scripts/copy-release-extensions.mjs': 'e27e79dcc7d17a1b7134b86f9c3137f31315921a',
 'scripts/copy-session-ui.mjs': 'e15e85785fd8027f9f76123ffa3ea4096f55006c',
 'scripts/dev-smoke.mjs': 'ec7eb158b7bb5d0ecb266c5e34c78e2073d2a3fa',
 'scripts/dev-smoke.test.mjs': 'b17fe4b8569762364bc3d928b6671ff161a901cf',
 'scripts/gate-commands.test.mjs': '6a126b10de889dcfb2a453c99144fbcde65a3818',
 'scripts/install-release-extensions.mjs': '0695080e0e45a1b9dc2427fc04ca36d9a2c8b4f4',
 'scripts/install-source-dependencies.mjs': '4619c416ec605916ede36489000eea0cacfab2d2',
 'scripts/ja-review-run.mjs': '0384c7a9f7cffe060ca23b58b4273773019f7eec',
 'scripts/live-flow-smoke.mjs': '72760fe53441d4f975583cc7a4817db8a1ff17d7',
 'scripts/live-flow-smoke.test.mjs': '14cb334acd18fd813cc27bea6769eaee7ce86704',
 'scripts/live-ja-smoke.mjs': '206eab29fadae31986f3cfa274244d503461a061',
 'scripts/live-locale-smoke.mjs': '5ef3c5eae3e6624afb3b903507212ee13d5c556f',
 'scripts/live-locale-smoke.test.mjs': 'bc928c0916eabb90e19b408e5df1245770597d28',
 'scripts/live-model-catalog.mjs': '81388ccfe472f56373c4831d7170f56f576768b8',
 'scripts/multiloop-flow-transform.mjs': 'aeb67130a0288ddb0b313faf5d597cda942c5838',
 'scripts/pack-check.mjs': 'cc1b119905ad786895fa07efcd2dec4c3d9457e7',
 'scripts/pack-check.test.mjs': '7a4b6f4964ce38f1bdec2dc7db3aedf89b9cf913',
 'scripts/pack-output.mjs': '5c5bbe5f5c03d2ab2649186866b8743cb22ecc25',
 'scripts/pack-output.test.mjs': '06e45bda98e13eb69a4bf2a21eddf6a71cfe1ba6',
 'scripts/patch-inputs.mjs': '489165750be330ecb82dd95bcbeca50b9f98e4d4',
 'scripts/pi-bug-report.test.mjs': '38ba3aca8a9fa2e77d6d562ebb1435d4e1cb073c',
 'scripts/pi-content-policy-transform.mjs': '44187b87ebc320f826d92658f9e40319b8bd968a',
 'scripts/pi-content-policy.test.mjs': 'dce2271220d366fd734ae06055c824e999a59ad7',
 'scripts/pi-flow-control-transform.mjs': 'e15b04cbe2c7ff352d80c8af1ebaf9494c72044a',
 'scripts/pi-flow-control.test.mjs': '42002110ee7a84feb4e4a6aaa9d35587e1db666e',
 'scripts/pi-flow-ingress-dispositions.test.mjs': '3dff2f1be2ee5620c0338ac04adf96241348c91a',
 'scripts/pi-flow-ingress.test.mjs': 'c926589460ea2e1e03d1f8d16a5db11e4e2c7d94',
 'scripts/pi-flow-rpc.test.mjs': '234cccc68b7140859a304af48e7fa4b61c2f7f17',
 'scripts/pi-ime-slash.test.mjs': 'f30b6e1ec770312db46b6ce2f8b0795792c20687',
 'scripts/pi-login-default.test.mjs': '0b53dd0b1e5666fbe7adee28127cc6987dcf8113',
 'scripts/pi-oauth-branding-transform.mjs': '3e43635735e279c2a024fff83d6241a24917923f',
 'scripts/pi-oauth-branding.test.mjs': '6c588b7897d531512fc7c8a0b9da7d3accf5ad19',
 'scripts/pi-path-utils-transform.mjs': '5692d620899ac60d955288423a11cb69df261a17',
 'scripts/pi-path-utils.test.mjs': '9131bcc9d90fc4181385054c2ff2039f8931d02f',
 'scripts/pi-provider-receipts-transform.mjs': '364069bfc9e4df262475dcaaa0611da0e112ae16',
 'scripts/pi-provider-receipts.test.mjs': '5d8c0b3d2cbb37643056611992534458945e48ca',
 'scripts/pi-summary-preparation.test.mjs': 'ea4521afca272378e5f771fe0c8dac2311a6a9d3',
 'scripts/pi-upstream.mjs': '9ab032ee651a50de9204127d1df8012a90141f17',
 'scripts/pi-upstream.test.mjs': '550fd3fc1a7c62a51b6e281cd1cbf9f710004cc8',
 'scripts/pi-user-input-binding.test.mjs': '7562683bcd5bdc6479413e998f328dc251b25ca8',
 'scripts/prepare-ci-artifacts.mjs': '54b413a9c726352d8a5499fa799995d61c40dfa1',
 'scripts/prepare-cli.mjs': 'a5d9932e76d2d644860b6e5e1b5cd6904bb121a6',
 'scripts/publish-npm.mjs': '7887086581c54c959c7f54ffb6233a6a34f86a18',
 'scripts/published-upgrade.mjs': '65280d08a1b276948a99f2e34035abd5e6a06fc8',
 'scripts/release-artifact.mjs': '876ac6ea15d3b85993a451ca0f1edbe06bb01076',
 'scripts/release-artifact.test.mjs': '32fac00d41afe1d966dfe7a03baceef0f898cfc7',
 'scripts/release-bundle-receipt.mjs': '2df26accebfdd8d63f7e5d48c1d87b59d202ef60',
 'scripts/release-bundle-receipt.test.mjs': 'e1d684649b12a9e5e9d68cbb5986e4a542840522',
 'scripts/release-publication-source.mjs': '2e7bc1458e7d8860b115eed95b1fb9c29f0043b2',
 'scripts/release-publication-source.test.mjs': 'd4ad959323f810ec8b487812675e4e4eb1363cf7',
 'scripts/run-tests.mjs': '5f243ae6ca0e503b2ef7984cff17e9dccecacde3',
 'scripts/run-tests.test.mjs': '75a634a0946add3710a6be23ef4db7abb8503f16',
 'scripts/smoke-phase.mjs': 'e20351d75be38f04e803e265a4d52f7785c92ad8',
 'scripts/smoke-phase.test.mjs': '729956b8bece8fc98e9cfb478b4db5a3bb1bbaca',
 'scripts/stress-tests.mjs': '7ef7a4fe10f12365489142f3def386f05f23a05b',
 'scripts/stress-tests.test.mjs': '91ed80d59e6fb56de6b004eb5c79d69e39f8af41',
 'scripts/task-flow-transform.mjs': '1a9887f30344955285a1fd7fe7850cd0ef6651a3',
 'scripts/test-auto-update.mjs': 'bd8c9f0692efd2754a042637f9e752f228ac8f01',
 'scripts/test-camoufox-client-import.mjs': '20f6acd46a8e3a99a6a681058ab7b40c4733d56b',
 'scripts/test-packed-camoufox.mjs': '8beadd3e0d94b706965e1cb98782552af182cb8c',
 'scripts/test-packed-cli.mjs': 'eba454c28bcb11acaf7cb7a787d5a915e1e13fa3',
 'scripts/test-task-continuation-integration.mjs': 'de58ff913d4a6707513593eabdca8112981ead22',
 'scripts/test-timing-reporter.mjs': '87dfdc4b201558eae908a013b042c8038bf36967',
 'scripts/test-timings.mjs': 'ee4d5324dfd73f1b852a2c785f64edbe49aa45e4',
 'scripts/test-timings.test.mjs': '8147df4308f1207974fd11ef819de9d36567233f',
 'scripts/textguard-artifact.test.mjs': '2749adf2e80448ec4f0e4e519ab56bee47043781',
 'scripts/vcc-goals-transform.mjs': 'b2d7596d5fa3e2dd7ece582b926be57ede6e5290',
 'scripts/vcc-goals.test.mjs': '78b777de96b7be72503a61c705c40435fe9c6dfb',
 'scripts/verify-published-release.mjs': '5141f9fa63f5584d988468a2520aa9f15b0fb4b9',
 'scripts/voice-package-boundary.mjs': 'fdcadbf1e9dac3e661f4a6e83a88d612aa034b9f',
 'scripts/webaio-defuddle-transform.mjs': 'de59a1aabbcb17ad6c2f00557d9e776c3c923b2c',
 'scripts/webaio-defuddle-transform.test.mjs': 'bbf6745ad9f78be788372ee710facbeee535c455',
 'scripts/webaio-package-boundary.mjs': '8c6e239b96e0f2110fe8be88d61a035410bb470e',
 'scripts/webaio-redirect-transform.mjs': 'f8747ccf9d2045408386a2c6fec992deee9d7e72',
 'scripts/windows-ci-defender.ps1': 'c47b3ba0ba352d5cfd7b703b49df8a6eb1d3ff22',
 'scripts/windows-ci-defender.test.ps1': '78520a55cd0dcd0c6f181044b39b8bea1f4a9afe',
 'scripts/windows-ci-paths.ps1': '478c2d3db691fdaaec8b2ea04289fc30613d1568',
 'scripts/windows-ci-paths.test.ps1': 'feefe67d6af8c333feada4b9795053ad450a124a',
 'scripts/write-dev-build-info.mjs': 'bbb3134e5abbd5ea30053c455261055c20234aba',
 'upstream/pi-content-policy/patch.lock.json': 'ceca3fea924013c9219687e2583706d03a04a1a0',
 'upstream/pi.lock.json': '8fb30b6e5192d43ffcded8569a696565fb898788'}
TABLE_HASHES={'dev-build-text.csv': '6c625b4a41359c634b7a253e5c1d686964e4c365e1cc034b9b0247de8dbc2b01', 'dev-build-text-scope.csv': '3e0fc08495eed96f67fda96affaf087a01e1c0aed6654fbb016baeb8f5c321db'}

BASE_SCOPE_HASH='d27944342dcf4900b4b6477ce460f48027c64134a6fe77b562f339e1e7ec995a'
ECHO_LINES={63,68,76,77,81,86,87,95,101,105,134,142,150,215,227,230,232,236,241,249,253,257,275,286,288,297,302,305,332,382,389,393,397,414,420,430,446,449,456,461,466,470,474,478,480,484,488,492,496,523,545,557,559,603,607,611,618,620,628,649}
BOUNDARIES={
'native-script-path':(4,5),'native-command-node-version':(59,70),'native-go-check':(73,90),
'native-repository':(92,108),'captured-dependency-inputs':(119,153),'native-receipt-predicate':(155,161),
'native-node-manifest-probe':(164,197),'native-receipt-write':(200,209),'native-npm-bootstrap':(211,259),
'native-target-resolution':(261,270),'native-global-link':(272,306),'captured-lock-control':(308,343),
'native-lock-cleanup':(350,372),'native-directory-lock':(374,402),'native-flock-reexec':(407,441),
'native-build-chain':(443,497),'native-hook-path-marker':(499,512),'native-hook-install':(514,547),
'generated-hook-delivery':(534,541),'native-hook-uninstall':(549,562),'native-hook-deferral':(564,595),
'hook-status-boundary':(597,623),'operator-invocation-boundary':(625,656)}


def main():
    for path,digest in TABLE_HASHES.items():
        assert hashlib.sha256((HERE/path).read_text(encoding='utf-8').encode()).hexdigest()==digest,path
    assert hashlib.sha256((HERE/'qualification-scripts-scope.csv').read_text(encoding='utf-8').encode()).hexdigest()==BASE_SCOPE_HASH
    with (HERE/'dev-build-text.csv').open(encoding='utf-8',newline='') as file:
        reader=csv.DictReader(file);assert reader.fieldnames==COLUMNS;rows=list(reader)
    with (HERE/'dev-build-text-scope.csv').open(encoding='utf-8',newline='') as file:
        reader=csv.DictReader(file);assert reader.fieldnames==SCOPE_COLUMNS;scope=list(reader)
    with (HERE/'qualification-scripts-scope.csv').open(encoding='utf-8',newline='') as file:base=list(csv.DictReader(file))
    assert len(rows)==1515 and len(scope)==134
    assert len({r['source'] for r in scope})==134
    assert all(r['revision']==REVISION for r in scope)
    hashed=[r for r in scope if r['sha256']]
    assert {r['source'] for r in hashed}==set(SOURCE_BLOBS) and len(hashed)==131
    for row in hashed:
        raw=(ROOT/row['source']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==row['sha256'],row['source']
        assert hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==SOURCE_BLOBS[row['source']],row['source']
    root_before={r['source'] for r in base if r['status'] in ('already-covered-elsewhere','fully-read-qualification-unit','pending-root-bash')}
    root_now={r['source'] for r in scope if r['status'] in ('already-covered-elsewhere','fully-read-dev-build-unit')}
    assert root_before==root_now and len(root_now)==81
    assert Counter(r['status'] for r in scope)==Counter({'already-covered-elsewhere':80,'fully-read-dev-build-unit':1,'excluded-test-body':38,'bounded-metadata-caller-support':12,'finite-scope':1,'read-only-lexical-method':1,'read-only-source-authority':1})
    text=read(SOURCE);lines=text.splitlines(keepends=True)
    assert len(lines)==656 and text.startswith('#!/usr/bin/env bash\nset -uo pipefail\n')
    assert len(function_ranges())==33
    parts=inventory_parts()
    assert Counter(p['kind'] for p in parts)==Counter({'shell-word':1385,'quoted-part':51,'generated-hook-word':32,'javascript-token':14,'parameter-default':7,'heredoc':2,'hashbang':1})
    assert len(parts)==1492
    expected={(p['kind'],p['start'],p['end']):p for p in parts};assert len(expected)==1492
    found={};boundary_found={};echo_found=set()
    for index,row in enumerate(rows,1):
        assert list(row)==COLUMNS and row['item_id']==f'DEV-BUILD-{index:04d}' and row['message_id']==''
        assert all(row[c] for c in COLUMNS if c not in ('english','message_id'))
        ev=json.loads(row['evidence']);assert ev['path']==SOURCE
        a,b=ev['start'],ev['end'];assert 0<=a<b<=len(text)
        line=text.count('\n',0,a)+1;assert row['english_location']==f'{SOURCE}:{line}'
        assert row['translation_boundary'].startswith(ev['role']+'. ')
        if ev['kind']=='delivery-boundary':
            assert row['english']=='' and ev['role']==ev['boundary_name']
            lo,hi=BOUNDARIES[ev['role']];assert line==lo and ev['line_end']==hi
            assert a==sum(map(len,lines[:lo-1])) and b==sum(map(len,lines[:hi]))
            assert ev['role'] not in boundary_found;boundary_found[ev['role']]=row
        else:
            key=(ev['kind'],a,b);assert key in expected and key not in found;found[key]=row
            part=expected[key];assert text[a:b]==row['english']==part['english']
            for field,value in part.items():
                if field not in ('kind','start','end','english'):assert ev[field]==value,(row['item_id'],field)
            assert ev['function']==function_at(a,b)
            if ev['role']=='fixed-echo-template':echo_found.add(line);assert ev['kind']=='shell-word' and row['english'].startswith('dev-build:')
            if ev['kind']=='generated-hook-word':assert 'unresolved' in row['display_location']
    assert set(found)==set(expected) and set(boundary_found)==set(BOUNDARIES) and echo_found==ECHO_LINES
    owned=[r for r in rows if json.loads(r['evidence'])['role'].startswith('fixed-')]
    assert len(owned)==65  #60echo +help +Node template/root +two parameter fallback fragments
    nodes=shell_lex(text)
    assert Counter(n['kind'] for n in nodes)==Counter({'space':2031,'word':1382,'operator':463,'comment':41,'command-substitution':35,'parameter':23,'regex-word':3,'heredoc':2,'heredoc-end':2,'hashbang':1,'process-substitution':1,'arithmetic':1,'continuation':1})
    assert [(n['delimiter'],n['quoted']) for n in nodes if n['kind']=='heredoc']==[('EOF',True),('NODE',True)]
    assert len({(p['parent_start'],p['parent_end']) for p in parts if p['kind']=='javascript-token'})==4
    assert len({(p['parent_start'],p['parent_end']) for p in parts if p['kind']=='generated-hook-word'})==6
    # Branch/sink guards: no execution; frozen source identities plus exact source snippets.
    guards=[
        'if ! write_dependency_receipt "$after_fingerprint"; then',
        'trap release_directory_lock EXIT',
        'JOUZU_DEV_BUILD_LOCK_HELD=1 flock -w "$(build_lock_timeout)" -E "$BUILD_LOCK_TIMEOUT_STATUS" -o',
        'return "$BUILD_LOCK_TIMEOUT_STATUS"',
        'if [[ "$command" != __hook && $# -gt 1 ]]; then',
        'usage >&2\n\t\t\treturn 2',
        'console.error(`dev-build: missing installed dependency ${name} for ${relative || "root"}`);\n\t\t\tprocess.exit(1);',
        '} catch {}',
        'if ! printf \'%s\\n\' "$$" >"$BUILD_LOCK_DIRECTORY/pid" 2>/dev/null; then',
    ]
    for fragment in guards:assert fragment in text,fragment
    hook=text[function_ranges()[-2][0]:function_ranges()[-2][1]]
    assert hook.count('return 0')==4 and 'status == BUILD_LOCK_TIMEOUT_STATUS' in hook and 'elif (( status != 0 ))' in hook
    warn=next(r for r in owned if r['english_location']==SOURCE+':257')
    assert 'successful' in warn['trigger'] and 'warning' in warn['trigger']
    for name in TABLE_HASHES:
        assert not any(line.rstrip()!=line for line in (HERE/name).read_text(encoding='utf-8').splitlines())
    assert not any(line.rstrip()!=line for line in Path(__file__).read_text(encoding='utf-8').splitlines())
    print('PASS dev-build-text:1515rows/1492lexical+23boundaries;656lines/33functions;root81=80prior+1new+0pending;134scope/131hash+main-blob identities. Source-only; no producer execution.')


if __name__=='__main__':main()
