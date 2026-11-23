from pathlib import Path
from html.parser import HTMLParser
import re, json, hashlib
from urllib.parse import quote

ROOT=Path(__file__).resolve().parent
OUT=ROOT.parent/'outputs/split118'
SOURCE=ROOT/'original'

def once(s,old,new):
    if s.count(old)!=1: raise ValueError(f'Expected one match ({s.count(old)}): {old[:100]}')
    return s.replace(old,new,1)

def script(s,id):
    m=re.search(r'<script\b[^>]*\bid="'+re.escape(id)+r'"[^>]*>(.*?)</script>',s,re.S|re.I)
    if not m: raise ValueError('Missing script '+id)
    return m

def change_script(s,id,fn):
    m=script(s,id)
    return s[:m.start(1)]+fn(m[1])+s[m.end(1):]

def without_script(s,id):
    m=script(s,id);return s[:m.start()]+s[m.end():]

def tagged(id,body,type=None):
    return '<script id="'+id+'"'+(' type="'+type+'"' if type else '')+'>'+body+'</script>\n'

class Spans(HTMLParser):
    def __init__(self,s):
        super().__init__(convert_charrefs=False)
        self.s=s;self.lines=[0];self.stack=[];self.spans=[]
        for m in re.finditer('\n',s):self.lines.append(m.end())
        self.feed(s)
    def pos(self):
        row,col=self.getpos();return self.lines[row-1]+col
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs);start=self.pos()
        if tag in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:
            self.spans.append((tag,attrs,start,start+len(self.get_starttag_text())))
        else:self.stack.append((tag,attrs,start))
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                t,a,start=self.stack[i];self.spans.append((t,a,start,self.s.index('>',self.pos())+1));del self.stack[i:];break

def remove_elements(s,predicate):
    targets=[(start,end) for tag,a,start,end in Spans(s).spans if predicate(tag,a)]
    selected=[]
    for start,end in sorted(targets):
        if not selected or start>=selected[-1][1]:selected.append((start,end))
    for start,end in reversed(selected):s=s[:start]+s[end:]
    return s,len(selected)

def coordinator(mode):return (ROOT/'src/split-coordinator118.js').read_text().replace('__MODE__',mode)

def runtime(s,mode):
    # Writes inside either app remain native. Maintenance on a shared origin waits
    # until the other app has closed, preventing stale-state overwrite on restore.
    a=s.index('async function freeze(){');b=s.index('\nconst engine=',a)
    old=s[a:b]
    old=once(old,' let cloudRelease=null;', ' let otherRelease=await root.SRSplit118.acquireOther();try{\n let cloudRelease=null;')
    old=once(old,'if(cloudRelease)await cloudRelease()};','try{if(cloudRelease)await cloudRelease()}finally{otherRelease()}};')
    old=old.rstrip()[:-1]+'}catch(e){otherRelease();throw e}\n}'
    s=s[:a]+old+s[b:]
    s=once(s,"async function recover(){if(!compatible)assertWritable();const recovered=await engine.recover();remove(LOCK);return recovered}",
      "async function recover(){if(!compatible)assertWritable();if(!read(PENDING)&&!read(LOCK))return false;return root.SRSplit118.exclusive(async()=>{const recovered=await engine.recover();remove(LOCK);return recovered})}")
    # Hydration is also a full local replacement, so it uses the same exclusion.
    start=s.index('async hydrateBeforeBoot(');body=s.index('{if(booted',start)+1
    end=s.index('\nroot.SRTransfer113=',body)
    tail=s[body:end]
    assert tail.endswith('}};') or tail.endswith('}};\n')
    tail=tail.rstrip();s=s[:body]+'return root.SRSplit118.exclusive(async()=>{'+tail[:-3]+'})}};\n'+s[end:]
    if mode=='analytics':
        a=s.index('function grant(action){');b=s.index('\nasync function freeze(){',a)
        s=s[:a]+(ROOT/'src/analytics-grant118.js').read_text().strip()+s[b:]
        # An analytics writer conflict must stop initialization, not allow editing.
        s=once(s,'if(!root.SRWriter101.owner){booted=true;return}',"if(!root.SRWriter101.owner)throw Error(root.SRWriter101.message)")
        s=s.replace('<small>SMART RETAIL ERP</small>','<small>SMART RETAIL ANALITIKA</small>')
        s=s.replace('ERPni tayyorlash yakunlanmadi.','Analitikani tayyorlash yakunlanmadi.')
    return s

def writer(s,mode):
    s=once(s,"request('smart-retail-business-writer-v101',","request(root.SRSplit118?.writerName||'smart-retail-business-writer-v101',")
    if mode=='analytics':
        s=s.replace('ERP oynasi','Analitika oynasi').replace('ERP fayli','Analitika fayli').replace('va ERPni','va Analitikani')
    return s

def backup(s):
    # Legacy HTML restore also touches shared local data.
    s=once(s,'working=true;let db;','working=true;let db,otherRelease;')
    s=once(s,'validate(p);authorize();if(read(pendingKey))','validate(p);authorize();otherRelease=await root.SRSplit118.acquireOther();if(read(pendingKey))')
    s=once(s,'      working=false;','      otherRelease?.();working=false;')
    s=once(s,'ownLock();const db=await openDb();','ownLock();const otherRelease=await root.SRSplit118.acquireOther();let db;try{db=await openDb();}catch(e){otherRelease();throw e}')
    s=once(s,'}finally{db.close();}','}finally{db.close();otherRelease();}')
    return s

def analytics_ui():
    s=(SOURCE/'inner_160.js').read_text()
    s=once(s,"function owner(){return !!root.emp70?.ready?.()&&root.emp70.owner()}","function owner(){return root.mergedCurrentAccess?.()?.role==='admin'}")
    s=s.replace("root.showToast?.('Zaxira oynasi administrator uchun.');","root.toast?.('Zaxira oynasi administrator uchun.');")
    s=s.replace('const token=T.grant(', 'const token=await T.grant(')
    s=s.replace('ERP, chat, analitika va fayllarni bitta paketga saqlang.', 'Shu brauzer manzilidagi analitika, fayllar va mavjud boshqa Smart Retail ma’lumotlarini saqlang.')
    s=s.replace("'Smart_Retail_'+scope+", "'Smart_Retail_Analitika_'+scope+")
    a=s.index('function install(){')
    s=s[:a]+'''function install(){
 const host=document.getElementById('view-settings');if(!host)return;
 let card=document.getElementById('sr113AnalyticsSettings');
 if(!card){card=document.createElement('div');card.id='sr113AnalyticsSettings';card.className='card';card.style.marginBottom='18px';card.innerHTML='<h3>To‘liq zaxira va ko‘chirish · ZIP</h3><p>Asl import fayllari, PRO AI sozlamalari va shu manzilda saqlangan ma’lumotlarni qamraydi. HTML / JSON eksporti faqat analitika hisobotining nusxasidir.</p><button class="btn primary" type="button">Zaxira oynasini ochish</button>';card.querySelector('button').onclick=open;host.prepend(card)}
 card.hidden=!owner();if(panel&&!owner())panel.hidden=true;
}
const update=root.mergedUpdateAccountUI;
if(typeof update==='function')root.mergedUpdateAccountUI=function(){const result=update.apply(this,arguments);install();return result};
document.addEventListener('DOMContentLoaded',install,{once:true});
root.addEventListener('storage',install);
if(document.readyState!=='loading')install();
})(window);
'''
    return s

outer=(SOURCE/'outer.html').read_text()
inner=(SOURCE/'inner.html').read_text()
assets=[m.group() for m in re.finditer(r'<script\b[^>]*\bid="sr108Asset-[^"]+"[^>]*>.*?</script>',outer,re.S)]
assert len(assets)==4
pro=re.search(r'const MERGED_PRO_HTML_B64\s*=\s*"([^"]+)"',outer)[1]

# ERP has all optional modules locally, with no dependency on a parent page.
assert inner.index('<head>')<200
erp=inner.replace('<head>', '<head>\n'+tagged('srSplit118Coordinator',coordinator('erp'))+'\n'.join(assets)+'\n'+tagged('sr108Asset-uzum',pro,'application/octet-stream'),1)
erp=change_script(erp,'writer101',lambda s:writer(s,'erp'))
erp=change_script(erp,'transferRuntime113',lambda s:runtime(s,'erp'))
erp=change_script(erp,'srBackup109',backup)
old=(SOURCE/'inner_083.js').read_text()
new=once(old,"legacy(payload));", "(()=>{const clean=new DOMParser().parseFromString(legacy(payload),'text/html');clean.querySelectorAll('#srerpEmbeddedState,#srerpEmbeddedBootstrap').forEach(n=>n.remove());return '<!DOCTYPE html>\\n'+clean.documentElement.outerHTML})());")
new=once(new,"script('stock107Hash',", "script('srSplit118Coordinator',document.getElementById('srSplit118Coordinator').textContent);\n    script('stock107Hash',")
new=new.replace('Smart Retail ERP v111 · Zaxira','Smart Retail ERP v118 · Zaxira')
erp=once(erp,old,new)
erp=erp.replace('<title>Smart Retail ERP v111</title>','<title>Smart Retail ERP v118</title>')
erp=once(erp,"document.title='Smart Retail ERP v111';", "document.title='Smart Retail ERP v118';")
# The old all-in-one /state route is never contacted implicitly by split files.
# The existing A13 provider remains available for the IT-managed Supabase setup.
old=(SOURCE/'inner_072.js').read_text();new=once(old,"  'use strict';", "  'use strict';\n  if(window.SRSplitLegacySync118!=='erp')return;")
erp=once(erp,old,new)
old=(SOURCE/'inner_158.js').read_text()
new=once(old,'    if(!allowed()||!loaded)return;',"    if(!allowed()||!loaded)return;\n    if(root.SRSplit118?.mode==='erp'){status('Uzum funnel Excel hisobotini shu oynada yuklang. Alohida Analitika faylidagi hisobotlar avtomatik ko‘chirilmaydi.');return;}")
new=once(new,"    $('up103Sync').onclick=()=>sync(true);", "    $('up103Sync').hidden=root.SRSplit118?.mode==='erp';\n    $('up103Sync').onclick=()=>sync(true);")
erp=once(erp,old,new)

# Analytics retains its entire reporting application and the PRO AI module.
analytics=outer
for id in ['sr108ErpPackage','smartRetailEmbeddedModule','smartRetailProtectedAccess','erpGuideModule50','sr108Assets']:
    analytics=without_script(analytics,id)
analytics,n=remove_elements(analytics,lambda tag,a: a.get('id','').startswith('sr108Asset-') or a.get('id') in {'view-retailerp','view-erpguide'} or tag=='button' and a.get('data-view') in {'retailerp','erpguide'})
assert n==8,n
assert analytics.index('<head>')<200
analytics=analytics.replace('<head>', '<head>\n'+tagged('srSplit118Coordinator',coordinator('analytics')),1)
analytics=change_script(analytics,'writer101Outer',lambda s:writer(s,'analytics'))
analytics=change_script(analytics,'transferRuntime113',lambda s:runtime(s,'analytics'))
analytics=change_script(analytics,'srBackup109',backup)
# Retain the existing read-only row scope rules; remove ERP SSO/session writes.
bridge=(SOURCE/'outer_023.js').read_text()
bridge=bridge[:bridge.index('  function ensurePrincipalUser(')]+"  root.smartRetailErpSessionBridge40=Object.freeze({version:118,analyticsAccess,resolvePrincipal});\n})(window);\n"
analytics=change_script(analytics,'smartRetailErpSessionBridge40',lambda _:bridge)
analytics=change_script(analytics,'smartRetailParentServerSync',lambda s:once(s,"  'use strict';", "  'use strict';\n  if(window.SRSplitLegacySync118!=='analytics')return;"))
analytics=once(analytics,'retailerp:initSmartRetailERP,','')
analytics=re.sub(r'^ retailerp:\[.*?\],\n|^ erpguide:\[.*?\],\n','',analytics,flags=re.M)
analytics=once(analytics,'function setView(name){','function setView(name){\n if(!document.getElementById("view-"+name))name="dashboard";')
analytics=analytics.replace('<title>Smart Retail ERP v111</title>','<title>Smart Retail Analitika v118</title>')
def manifest(s):
    m=json.loads(s);m['name']='Smart Retail Analitika';m['short_name']='Analitika';m['description']='SellerSmart — Uzum hisobotlari va PRO AI';return json.dumps(m,ensure_ascii=False,separators=(',',':'))
analytics=change_script(analytics,'sr105ManifestData',manifest)
m=re.search(r'<link\b[^>]*id="sr105Manifest"[^>]*>',analytics)
assert m
link=re.sub(r'href="[^"]*"', 'href="data:application/manifest+json;charset=utf-8,'+quote(script(analytics,'sr105ManifestData')[1],safe='')+'"',m[0])
analytics=analytics[:m.start()]+link+analytics[m.end():]
analytics=analytics.replace('<b>Smart Retail ERP</b><small>Ombor, POS va operatsion boshqaruv bir tizimda</small>', '<b>Smart Retail Analitika</b><small>Uzum hisobotlari, SKU va foyda tahlili</small>')
analytics=analytics.replace('<span>ERP</span><span>Offline</span>', '<span>SKU</span><span>Offline</span>')
analytics=analytics.replace('ERP / Ombor boshqaruvi</div>', 'Sozlamalar va zaxira</div>')
analytics=analytics.replace('Mustaqil faylda ma’lumotlar qurilmada saqlanadi. Server versiyasida ERP va analitika himoyalangan bazaga sinxronlanadi.', 'Ma’lumotlar shu brauzerda saqlanadi. Zaxira nusxasini alohida saqlang.')
analytics=analytics.replace('ERP ma’lumotlari avtomatik uzatiladi.', 'Yuklangan funnel hisobotlari tahlilga uzatiladi.')
guide=[(start,end) for tag,a,start,end in Spans(analytics).spans if a.get('id')=='guideItem29']
assert len(guide)==1
a,b=guide[0]
replacement='<details class="guide-section" id="guideItem29"><summary>29. ERP alohida faylda</summary><div class="guide-body"><p>WMS, POS, CRM, xodimlar va do‘kon boshqaruvi uchun <b>Smart_Retail_ERP_v118.html</b> faylini oching. Ushbu fayl Uzum analitikasi va PRO AI uchun.</p><p>Har bir fayl o‘z kirish oynasi bilan ishlaydi. Fayllarni boshqa qurilmaga ko‘chirishdan oldin to‘liq ZIP zaxira oling; HTMLning o‘zi brauzerdagi ma’lumotlarni ko‘chirmaydi.</p></div></details>'
analytics=analytics[:a]+replacement+analytics[b:]
analytics=analytics.replace('29. Smart Retail ERP — WMS/POS/CRM/Finance ichki tizimi','29. ERP alohida faylda')
body=[(start,end) for tag,a,start,end in Spans(analytics).spans if tag=='body']
assert len(body)==1
at=analytics.rfind('</body>',body[0][0],body[0][1])
analytics=analytics[:at]+tagged('analyticsBackupUI118',analytics_ui())+'\n'+analytics[at:]

OUT.mkdir(parents=True,exist_ok=True)
for name,s in [('Smart_Retail_Analitika_v118.html',analytics),('Smart_Retail_ERP_v118.html',erp)]:
    (OUT/name).write_text(s)
    print(name,len(s.encode()),hashlib.sha256(s.encode()).hexdigest())
