/* Shared image settings, saved prompts and validated design plans. */
(function(){
"use strict";
const layouts=["hero","split_left","split_right","features","pack"],modes=["normal","minimal","none"];
const palettes=[["#eef5fb","#2857ca"],["#f2edf9","#7639bd"],["#edf8f5","#137768"],["#fff4e8","#bc6525"],["#edf1f8","#33465c"]];
function settings(value){
 const v=value||{},count=v.count===undefined?3:Number(v.count),prompt=String(v.prompt||"").trim();
 if(!Number.isInteger(count)||count<1||count>10)throw Error("Rasm soni 1–10 oralig‘idagi butun son bo‘lishi kerak.");
 if(prompt.length>2000)throw Error("Rasm prompti 2000 belgidan oshmasin.");
 return {count,prompt};
}
function defaults(count){return Array.from({length:count},(_,i)=>({background:palettes[i%5][0],accent:palettes[i%5][1],layout:layouts[i%5],text_mode:"normal",photo_scale:i<5?.96:.84}));}
function validPlan(p,fallback){
 p=p||{};return {background:/^#[0-9a-f]{6}$/i.test(p.background)?p.background:fallback.background,accent:/^#[0-9a-f]{6}$/i.test(p.accent)?p.accent:fallback.accent,layout:layouts.includes(p.layout)?p.layout:fallback.layout,text_mode:modes.includes(p.text_mode)?p.text_mode:"normal",photo_scale:Number.isFinite(p.photo_scale)&&p.photo_scale>=.7&&p.photo_scale<=1?p.photo_scale:fallback.photo_scale};
}
function plans(count,design){const fallback=defaults(count),saved=Array.isArray(design?.plans)?design.plans:[];return fallback.map((v,i)=>validPlan(saved[i]||(saved.length?{...saved[i%saved.length],layout:v.layout,photo_scale:v.photo_scale}:null),v));}
function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function button(text,action,cls){const b=node("button",cls,text);b.type="button";b.addEventListener("click",action);return b;}
let fieldId=0;
function editor(host,onChange){
 const storageKey="sellersmart-image-prompts-v1";let presets=[],selectedId="",disabled=false,notice="",draft={count:3,prompt:"",name:""};
 try{const raw=localStorage.getItem(storageKey);if(raw){const saved=JSON.parse(raw)||{};
  presets=Array.isArray(saved.presets)?saved.presets.filter(p=>p&&typeof p.id==="string"&&typeof p.name==="string"&&p.name.length<=64&&typeof p.prompt==="string"&&p.prompt.trim()&&p.prompt.length<=2000).slice(0,30):[];selectedId=presets.some(p=>p.id===saved.selectedId)?saved.selectedId:"";
  const savedCount=Number(saved.draft?.count),validCount=Number.isInteger(savedCount)&&savedCount>=1&&savedCount<=10;
  draft={count:validCount?savedCount:3,prompt:typeof saved.draft?.prompt==="string"?saved.draft.prompt.slice(0,2000):"",name:String(saved.draft?.name||"").slice(0,64)};
  if(!validCount)notice="Rasm soni 3 taga tiklandi. Saqlangan promptlar saqlab qolindi.";
 }}
 catch(e){notice="Saqlangan rasm sozlamalari ochilmadi. Yangi prompt kiritishingiz mumkin.";}
 host.classList.add("it-editor");
 const countBox=node("div","it-count"),countLabel=node("label","","Rasm soni"),count=node("input");count.id="image-count";count.type="number";count.min="1";count.max="10";count.step="1";count.value=draft.count;countLabel.htmlFor=count.id;countBox.append(countLabel,count,node("small","","1–10 ta. Har bir rasm uchun alohida kompozitsiya."));
 const label=node("label","it-label","Rasm uchun qo‘shimcha prompt"),prompt=node("textarea");prompt.id="image-prompt";label.htmlFor=prompt.id;prompt.rows=4;prompt.maxLength=2000;prompt.value=draft.prompt;prompt.placeholder="Masalan: och ko‘k fon, mahsulot katta va chapda, o‘ngda qisqa ruscha matn. Minimal uslub.";
 const counter=node("small","it-counter"),help=node("small","it-help","Fon, ranglar, mahsulot joylashuvi va matn hajmini yozing. Prompt keyingi tayyorlashda qo‘llanadi; mahsulotning asl surati saqlanadi.");
 const savedBox=node("div","it-saved"),savedLabel=node("label","","Saqlangan promptlar"),select=node("select");select.id="saved-image-prompts";savedLabel.htmlFor=select.id;
 const nameLabel=node("label","","Prompt nomi"),name=node("input");name.id="image-prompt-name";nameLabel.htmlFor=name.id;name.maxLength=64;name.value=draft.name;name.placeholder="Masalan: Ko‘k minimal dizayn";
 const actions=node("div","it-actions"),msg=node("p","it-status");msg.setAttribute("role","status");msg.setAttribute("aria-live","polite");msg.textContent=notice;
 function update(){draft={count:count.value,prompt:prompt.value,name:name.value};counter.textContent=prompt.value.length+" / 2000";if(onChange)onChange();}
 function persist(){try{localStorage.setItem(storageKey,JSON.stringify({draft,selectedId,presets}));return true;}catch(e){msg.textContent="Brauzer doimiy saqlashga ruxsat bermadi. Prompt joriy oynada qoladi.";return false;}}
 function drawSelect(){select.replaceChildren();const empty=node("option","","+ Yangi prompt");empty.value="";select.appendChild(empty);for(const p of presets){const o=node("option","",p.name);o.value=p.id;select.appendChild(o);}select.value=selectedId;refreshButtons();}
 function refreshButtons(){edit.disabled=disabled||!selectedId;remove.disabled=disabled||!selectedId;}
 const save=button("Promptni saqlash",()=>{
  try{const value=settings({count:count.value,prompt:prompt.value});if(!value.prompt)throw Error("Saqlash uchun prompt matnini kiriting.");
   const title=name.value.trim()||value.prompt.slice(0,50);if(presets.some(p=>p.id!==selectedId&&p.name.toLowerCase()===title.toLowerCase()))throw Error("Bu nomdagi prompt bor. Boshqa nom kiriting yoki o‘sha promptni tanlang.");
   if(!selectedId&&presets.length>=30)throw Error("30 ta prompt saqlangan. Avval keraksiz promptni o‘chiring.");
   const id=selectedId||"prompt-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,7),item={id,name:title,prompt:value.prompt};
   const pos=presets.findIndex(p=>p.id===id);if(pos>=0)presets[pos]=item;else presets.push(item);selectedId=id;name.value=title;prompt.value=value.prompt;update();drawSelect();if(persist())msg.textContent=pos>=0?"Prompt tahriri saqlandi.":"Yangi prompt saqlandi.";
  }catch(e){msg.textContent=e.message;}
 },"it-primary");
 const edit=button("Tahrirlash",()=>{prompt.focus();msg.textContent="Matn yoki nomni o‘zgartirib, «Promptni saqlash»ni bosing.";});
 const remove=button("Saqlanganni o‘chirish",()=>{presets=presets.filter(p=>p.id!==selectedId);selectedId="";prompt.value="";name.value="";update();drawSelect();if(persist())msg.textContent="Saqlangan prompt o‘chirildi va faol prompt olib tashlandi.";},"it-delete");
 const clear=button("Promptni olib tashlash",()=>{selectedId="";prompt.value="";name.value="";update();drawSelect();if(persist())msg.textContent="Faol prompt olib tashlandi. Saqlangan promptlar ro‘yxatda qoladi.";});
 actions.append(save,edit,remove,clear);savedBox.append(savedLabel,select,nameLabel,name,actions);host.append(countBox,label,prompt,counter,help,savedBox,msg);
 select.addEventListener("change",()=>{selectedId=select.value;const p=presets.find(p=>p.id===selectedId);prompt.value=p?.prompt||"";name.value=p?.name||"";update();refreshButtons();persist();msg.textContent=p?"Prompt yuklandi. Tahrirlash yoki keyingi tayyorlashda ishlatish mumkin.":"Yangi prompt yozing.";});
 for(const input of [count,prompt,name])input.addEventListener("input",()=>{update();persist();});
 drawSelect();counter.textContent=prompt.value.length+" / 2000";
 return {get:()=>settings({count:count.value,prompt:prompt.value}),peekCount:()=>Number(count.value),setDisabled:value=>{disabled=value;host.querySelectorAll("input,textarea,select,button").forEach(el=>el.disabled=value);refreshButtons();}};
}
window.ImageTools={settings,defaults,plans,editor};
})();
