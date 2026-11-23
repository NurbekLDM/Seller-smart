"use strict";
const $=id=>document.getElementById(id);
const config=JSON.parse($("studio-config").textContent);
const sourceMode=config.source_mode||"uzum",external=sourceMode==="external";
function renderSourceMode(){
 $(external?"nav-external":"nav-uzum").setAttribute("aria-current","page");
 if(!external)return;
 document.title="SellerSmart · Boshqa saytdan";
 $("page-heading").textContent="Boshqa saytdan — Uzumga";
 $("page-description").textContent="Mahsulot havolasini joylang. Uzum uchun tayyor UZ/RU kartochka oling.";
 $("external-intro").hidden=false;
 $("url-label").textContent="Istalgan saytdagi mahsulot havolasi";
 $("product-url").placeholder="https://sayt.uz/products/mahsulot";
 $("url-help").textContent="Bosh sahifa yoki qidiruv natijasini emas, aynan mahsulot sahifasini kiriting.";
 $("web-source-label").textContent="Sahifadan matn olinmasa, OpenAI veb-qidiruvi bilan aynan shu mahsulot havolasini tekshirish.";
 $("extra").placeholder="Masalan: qora variant uchun yozing. Tasdiqlangan qo‘shimcha parametrlarni shu yerga kiriting.";
}
const variantStorageKey="sellersmart-variants-v1";
let initialVariants=PackVariants.defaults();
try{const saved=localStorage.getItem(variantStorageKey);if(saved)initialVariants=PackVariants.validate(PackVariants.normalize(JSON.parse(saved)));}catch(e){$("variant-storage-note").textContent="Saqlangan variantlar ochilmadi. Boshlang‘ich 1 va 2 dona tiklandi.";}
const variantEditor=PackVariants.editor($("variant-editor"),initialVariants,items=>{
 try{localStorage.setItem(variantStorageKey,JSON.stringify(items));$("variant-storage-note").textContent="Variantlar shu brauzerda saqlandi.";}
 catch(e){$("variant-storage-note").textContent="Variantlar joriy oynada saqlandi. Brauzer doimiy saqlashga ruxsat bermadi.";}
});
let imported=null,importedUrl="",busy=false,offlineCard=null;
let modelAvailability=null,modelCheckId=0,checkingModels=false;
const imageEditor=ImageTools.editor($("image-settings-editor"),()=>{if(document.querySelector('input[name="detail-level"]:checked'))updateOptions();});
const chosenModels={"6":config.model,"5":"gpt-5.6-sol"};
function options(){return {level:document.querySelector('input[name="detail-level"]:checked').value,stickers:$("stickers").checked,symbols:$("symbols").checked,copywriting:$("copywriting").checked,properties:$("properties-enabled").checked,images:$("images-enabled").checked,pro_infographic:$("images-enabled").checked&&$("pro-infographic").checked};}
function updateOptions(){
 const settings=options(),pro=settings.pro_infographic,count=imageEditor.peekCount();
 imageEditor.setDisabled(busy||!settings.images);
 $("image-options").hidden=!settings.images;$("pro-details").hidden=!pro;$("standard-images").hidden=pro;
 $("pro-infographic").disabled=busy||!settings.images;$("image-mode").disabled=busy||!settings.images||pro;
 const level=config.levels[settings.level];
 $("plan-summary").textContent=level.title+" · "+level.range+" · "+(settings.properties?"Xususiyatlar bilan":"Xususiyatlar jadvalisiz")+" · "+(!settings.images?"Rasmsiz":(Number.isInteger(count)&&count>=1&&count<=10?count+" ta ":"Rasm sonini kiriting · ")+(pro?"PRO infografika":"rasm"));
}
function renderLevels(){
 for(const [id,level] of Object.entries(config.levels)){
  const label=document.createElement("label");label.className="detail-option";
  const input=document.createElement("input");input.type="radio";input.name="detail-level";input.value=id;input.checked=id==="2";
  const title=document.createElement("b");title.textContent=id+". "+level.title;
  const desc=document.createElement("span");desc.textContent=level.description;
  const range=document.createElement("small");range.textContent=level.range;
  label.append(input,title,desc,range);$("detail-levels").appendChild(label);input.addEventListener("change",updateOptions);
 }
 updateOptions();
}
function apiKey(){const key=$("key").value.trim();if(!/^sk-[^\s]{11,509}$/.test(key))throw new RequestProblem("OpenAI platformasidan olingan sk- kalitini kiriting.","invalid_key");return key;}
function currentFamily(){return document.querySelector('input[name="model-family"]:checked').value;}
function modelHint(){const model=config.models.find(x=>x.id===$("model").value);$("model-hint").textContent=model?model.hint+" API: "+model.id:"Modelni tanlang.";}
function renderModels(){
 const family=currentFamily(),select=$("model");select.replaceChildren();
 for(const m of config.models.filter(x=>x.family===family)){
  const option=document.createElement("option");option.value=m.id;
  const state=modelAvailability&&modelAvailability.get(m.id);
  option.textContent=m.label+(state===true?" · mavjud":state===false?" · bu kalitda yo‘q":"");
  option.disabled=state===false;select.appendChild(option);
 }
 select.value=chosenModels[family];modelHint();
}
async function checkModels(){
 if(busy||checkingModels)return;let key;
 try{key=apiKey();}catch(e){showError(e.message);return;}
 const requestId=++modelCheckId;checkingModels=true;$("check-models").disabled=true;$("start").disabled=true;
 $("model-status").textContent="Kalitingizga ochiq modellar tekshirilmoqda…";$("error-box").hidden=true;
 try{
  const data=await post("/api/models",{key},28000);
  if(requestId!==modelCheckId)return;
  modelAvailability=new Map(data.models.map(m=>[m.id,m.available]));renderModels();
  const count=data.models.filter(m=>m.available).length;
  $("model-status").textContent=count?count+" ta model ro‘yxatda mavjud. Vosita ruxsatlari so‘rov paytida tekshiriladi.":"Ushbu kalit ro‘yxatida mos model topilmadi. Boshqa API loyihasini tekshiring.";
 }catch(e){if(requestId===modelCheckId){modelAvailability=null;renderModels();$("model-status").textContent=e.message;}}
 finally{key="";checkingModels=false;$("check-models").disabled=busy;$("start").disabled=busy;}
}
function renderPresets(){
 const box=$("presets");
 for(const [id,value] of Object.entries(config.presets)){
  const lab=document.createElement("label");lab.className="preset";
  const radio=document.createElement("input");radio.type="radio";radio.name="preset";radio.value=id;radio.checked=id==="sales";
  const title=document.createElement("b");title.textContent=value.title;
  const summary=document.createElement("span");summary.textContent=value.description;
  lab.append(radio,title,summary);box.appendChild(lab);
  radio.addEventListener("change",()=>{$("preset-text").textContent=value.prompt;});
 }
 $("preset-text").textContent=config.presets.sales.prompt;renderModels();
}
function setProgress(stage,message){
 const order=["read","generate","media"];const pos=stage==="done"?3:order.indexOf(stage);
 for(const li of $("steps").children){
  const ix=order.indexOf(li.dataset.step);li.classList.toggle("is-running",ix===pos);li.classList.toggle("is-done",pos>=0&&ix<pos);
  li.querySelector("i").textContent=pos>=0&&ix<pos?"✓":String(ix+1);
 }
 $("progress").textContent=message;
}
function lock(value){
 busy=value;variantEditor.setDisabled(value);
 for(const f of $("generator-form").querySelectorAll("input,textarea,button,select")) f.disabled=value;
 $("manual-go").disabled=value;
 $("start").innerHTML=value?"Jarayon davom etmoqda…":'<span class="run-icon">▷</span> Jarayonni boshlash';
 updateOptions();
}
function showError(message){$("error-box").textContent=message;$("error-box").hidden=false;}
class RequestProblem extends Error{constructor(message,code){super(message);this.code=code;}}
async function post(path,body,limit){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),limit||180000);
 try{
  const r=await fetch(path,{method:"POST",cache:"no-store",credentials:"same-origin",referrerPolicy:"no-referrer",
   headers:{"Content-Type":"application/json","X-Kartochka-Studio":"1"},body:JSON.stringify(body),signal:controller.signal});
  const d=await r.json().catch(()=>({error:"Mahalliy server javobini o‘qib bo‘lmadi."}));
  if(!r.ok)throw new RequestProblem(d.error||"So‘rov bajarilmadi.",d.code||"request");
  return d;
 }catch(e){if(e instanceof RequestProblem)throw e;
  throw new RequestProblem(e.name==="AbortError"?"Javob belgilangan vaqtda kelmadi. Qayta urinishdan oldin API hisobingizdagi so‘rovni tekshiring.":"Mahalliy server bilan aloqa uzildi. Ishga tushirish oynasi ochiq ekanini tekshiring.","network");
 }finally{clearTimeout(timer);}
}
function values(){
 const url=$("product-url").value.trim(),key=apiKey(),model=$("model").value;
 if(!model||modelAvailability&&modelAvailability.get(model)===false)throw new RequestProblem("Tanlangan model bu kalitda mavjud emas. Ro‘yxatdan ochiq modelni tanlang.","model");
 let u;try{u=new URL(url);}catch{throw new RequestProblem("Mahsulotning to‘liq havolasini kiriting.","invalid_url");}
 if(external){if(!["http:","https:"].includes(u.protocol)||u.username||u.password)throw new RequestProblem("Ochiq mahsulot sahifasining HTTP yoki HTTPS havolasini kiriting.","invalid_url");}
 else if(u.protocol!=="https:"||!["uzum.uz","www.uzum.uz","m.uzum.uz"].includes(u.hostname)||!u.pathname.includes("/product/")||u.username||u.password)throw new RequestProblem("Uzumdagi aynan mahsulot sahifasining HTTPS havolasini kiriting.","invalid_url");
 const imageSettings=options().images?{...imageEditor.get(),mode:options().pro_infographic?"infographic":$("image-mode").value}:{count:3,prompt:"",mode:"infographic"};
 return {url,key,image_settings:imageSettings,variants:variantEditor.get(),source_mode:sourceMode,preset:document.querySelector('input[name="preset"]:checked').value,extra:$("extra").value,seo:$("seo").checked,model,image_mode:$("image-mode").value,options:options()};
}
function askForSource(text){$("manual-reason").textContent=text+" Mahsulot nomi va tavsifini "+(external?"saytdan":"Uzumdan")+" nusxalang. Natijada bu manba «Sotuvchi kiritgan matn» deb belgilanadi.";$("manual-box").hidden=false;setProgress("read","Kartochka matni kerak.");$("manual-title").focus();}
async function run(manual){
 if(busy||checkingModels)return;
 $("error-box").hidden=true;
 let v;
 try{v=values();}catch(e){showError(e.message);return;}
 lock(true);
 try{
  if(manual){
   imported=await post("/api/manual",{url:v.url,source_mode:sourceMode,title:$("manual-title").value,description:$("manual-description").value},25000);
   importedUrl=v.url;
  }else if(!imported||importedUrl!==v.url){
   setProgress("read",external?"Saytdan mahsulot nomi, tavsifi va asl suratlari olinmoqda…":"Uzum mahsulot nomi, tavsifi va SKU ma’lumotlari o‘qilmoqda…");
   try{imported=await post("/api/source",{url:v.url,source_mode:sourceMode},40000);}
   catch(e){
    if(e.code!=="source_missing")throw e;
    if(!$("use-web").checked){askForSource(e.message);return;}
    setProgress("read","Ochiq sahifadan yetarli ma’lumot olinmadi. OpenAI aynan shu havolani tekshirmoqda…");
    try{imported=await post("/api/web-source",{url:v.url,source_mode:sourceMode,key:v.key,model:v.model});}
    catch(lookup){
     if(["source_missing","openai_request","openai_access","incomplete","model_output"].includes(lookup.code)){askForSource(lookup.message);return;}
     throw lookup;
    }
   }
   importedUrl=v.url;
  }
  $("manual-box").hidden=true;
  setProgress("generate",config.levels[v.options.level].title+" darajada UZ/RU kartochka tayyorlanmoqda: "+imported.source.title);
  let answer;
  try{answer=await post("/api/generate",{...v,ticket:imported.ticket},330000);}
  catch(e){if(e.code==="source_expired"||e.code==="source_mismatch"){imported=null;importedUrl="";}throw e;}
  // The result contains only product fields, source evidence and seller-defined pack sizes.
  offlineCard=answer.card;offlineCard.posters=[];offlineCard.photo="";offlineCard.image_mode=v.image_mode;
  CardStudio.mount($("card-editor"),offlineCard,imported.ticket);$("result").hidden=false;
  if(v.options.images){
   setProgress("media","Matn tayyor. Asl suratdan "+(v.image_settings.count+" ta "+(v.options.pro_infographic?"PRO infografika":"rasm"))+" tayyorlanmoqda…");
   if(imported.source.photos.length){
    try{const photo=await post("/api/product-photo",{url:v.url,source_mode:sourceMode,key:v.key,model:v.model,ticket:imported.ticket,images_enabled:true},225000);await CardStudio.useProductPhoto(photo);}catch(e){offlineCard.media_note=e.message;}
   }else{offlineCard.media_note="Manbadan surat olinmadi. «Surat tanlash» orqali asl suratni yuklang va mahsulot chegarasini belgilang.";}
  }else{offlineCard.media_note="Rasm tayyorlash o‘chirilgan. Surat uchun API so‘rovi bajarilmadi.";}
  $("key").value="";$("key").type="password";$("reveal-key").textContent="Ko‘rsatish";$("reveal-key").setAttribute("aria-pressed","false");
  modelCheckId++;modelAvailability=null;renderModels();$("model-status").textContent="Kalit xotiradan tozalandi. Keyingi kartochka uchun API kalitini kiriting.";
  CardStudio.refreshMedia();
  const count=offlineCard.posters.length;
  setProgress("done",!v.options.images?"Matn tayyor. Rasm tayyorlash o‘chirilgan.":count?"Kartochka va "+count+" ta "+(v.options.pro_infographic?"PRO infografika":"rasm")+" tayyor.":"Kartochka matni tayyor. Infografika uchun surat tanlang.");
  $("result").scrollIntoView({behavior:"smooth",block:"start"});
 }catch(e){showError(e.message||"Jarayon tugamadi.");setProgress("", "Jarayon to‘xtadi. Xabarni tekshirib qayta boshlang.");}
 finally{if(v)v.key="";lock(false);}
}
$("generator-form").addEventListener("submit",e=>{e.preventDefault();run(false);});
$("check-models").addEventListener("click",checkModels);
$("model").addEventListener("change",()=>{chosenModels[currentFamily()]=$("model").value;modelHint();});
for(const radio of document.querySelectorAll('input[name="model-family"]'))radio.addEventListener("change",renderModels);
$("key").addEventListener("input",()=>{modelCheckId++;modelAvailability=null;renderModels();$("model-status").textContent="Akkauntingizdagi mavjudlik API kaliti bilan tekshiriladi.";});
$("manual-go").addEventListener("click",()=>run(true));
$("open-manual").addEventListener("click",()=>askForSource("Asl mahsulot matnidan foydalanishingiz mumkin."));
$("product-url").addEventListener("input",()=>{imported=null;importedUrl="";$("manual-box").hidden=true;$("error-box").hidden=true;$("manual-title").value="";$("manual-description").value="";setProgress("","Boshlashga tayyor");});
$("reveal-key").addEventListener("click",()=>{const show=$("key").type==="password";$("key").type=show?"text":"password";$("reveal-key").textContent=show?"Yashirish":"Ko‘rsatish";$("reveal-key").setAttribute("aria-pressed",String(show));$("reveal-key").setAttribute("aria-label",show?"Kalitni yashirish":"API kalitini ko‘rsatish");});
$("export-main").addEventListener("click",e=>{if(!offlineCard){e.preventDefault();return;}CardStudio.saveExport(e);});
renderSourceMode();renderPresets();
renderLevels();
for(const id of ["images-enabled","pro-infographic","image-mode","stickers","symbols","copywriting","properties-enabled"])$(id).addEventListener("change",updateOptions);

