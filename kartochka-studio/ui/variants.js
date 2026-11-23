/* Shared variant data and editor. Included in standalone HTML exports. */
(function(){
"use strict";
const MAX=12, keys=["label_uz","label_ru","sku","note_uz","note_ru"];
function defaults(){return [1,2].map(count=>({count,label_uz:count+" dona",label_ru:count+" шт.",sku:"",note_uz:"",note_ru:""}));}
function normalize(items){
 if(!Array.isArray(items))return defaults();
 return items.map(v=>{const row={count:Number(v.count)};for(const k of keys)row[k]=String(v[k]||"").trim();row.label_uz=row.label_uz||row.count+" dona";row.label_ru=row.label_ru||row.count+" шт.";return row;});
}
function validate(items){
 if(!Array.isArray(items)||!items.length||items.length>MAX)throw Error("1 tadan "+MAX+" tagacha sotuv variantini kiriting.");
 const skus=new Set(),names=new Set();
 items.forEach((v,i)=>{
  const at=(i+1)+"-variant: ";
  if(!Number.isInteger(v.count)||v.count<1||v.count>9999)throw Error(at+"dona soni 1–9999 oralig‘idagi butun son bo‘lishi kerak.");
  for(const k of keys){const limit=k==="sku"?64:k.startsWith("note_")?240:60;if(typeof v[k]!=="string"||v[k].length>limit)throw Error(at+"matn uzunligini tekshiring (ko‘pi bilan "+limit+" belgi).");}
  if(v.sku&&!/^[A-Za-z0-9_-]+$/.test(v.sku))throw Error(at+"SKU uchun lotin harflari, raqam, - va _ ishlating.");
  if(v.sku&&skus.has(v.sku.toUpperCase()))throw Error(at+"bu SKU boshqa variantda ishlatilgan.");
  if(v.sku)skus.add(v.sku.toUpperCase());
  const identity=[v.count,v.label_uz.toLowerCase(),v.label_ru.toLowerCase()].join("|");
  if(names.has(identity))throw Error(at+"bu variant allaqachon mavjud. Nomi yoki dona sonini o‘zgartiring.");
  names.add(identity);
 });
 return items;
}
function assignSkus(items,base){
 const result=normalize(items),used=new Set(result.filter(v=>v.sku).map(v=>v.sku.toUpperCase()));
 base=String(base||"UZ-MAHSULOT").toUpperCase().replace(/[^A-Z0-9_-]/g,"-").slice(0,24)||"UZ-MAHSULOT";
 for(const v of result){if(v.sku)continue;let sku=base+"-"+v.count,n=2;while(used.has(sku.toUpperCase()))sku=base+"-"+v.count+"-"+(n++);v.sku=sku;used.add(sku.toUpperCase());}
 return result;
}
function label(v,lang){const basic=v.count+(lang==="uz"?" dona":" шт."),name=v["label_"+lang];return !name||name===basic?basic:name+" ("+basic+")";}
function shortText(items,lang){
 const counts=[...new Set(items.map(v=>v.count))];
 if(counts.length===items.length)return lang==="uz"?"To‘plam: "+counts.join(" / ")+" dona.":"В комплекте: "+counts.join(" / ")+" шт.";
 return lang==="uz"?"Sotuv variantlari: "+items.length+" ta.":"Вариантов комплекта: "+items.length+".";
}
function blockText(items,lang){return (lang==="uz"?"Sotuv variantlari:":"Варианты комплекта:")+"\n"+items.map(v=>label(v,lang)+(v["note_"+lang]?" — "+v["note_"+lang]:"")).join("\n");}
function blocks(items,lang){const block=blockText(items,lang);return {short:shortText(items,lang),full:block,composition:block};}
function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function button(text,fn,cls){const b=node("button",cls,text);b.type="button";b.addEventListener("click",fn);return b;}
let fieldNo=0;
function editor(container,initial,onChange,opts){
 opts=opts||{};let items=normalize(initial),disabled=false,undo=null;
 container.classList.add("pv-editor");
 function commit(next){validate(next);items=opts.skuBase?assignSkus(next,opts.skuBase):normalize(next);draw();onChange(items.map(v=>({...v})));}
 function edit(index){
  if(disabled)return;
  const isNew=index===null;
  let count=1;while(items.some(v=>v.count===count))count++;
  const draft=isNew?{count,label_uz:count+" dona",label_ru:count+" шт.",sku:"",note_uz:"",note_ru:""}:{...items[index]};
  const dialog=node("dialog","pv-dialog");const heading=node("h2","",isNew?"Yangi sotuv varianti":"Variantni tahrirlash");heading.id="pv-title-"+(++fieldNo);dialog.setAttribute("aria-labelledby",heading.id);dialog.appendChild(heading);
  dialog.appendChild(node("p","pv-help","Dona soni va nomini kiriting. SKU bo‘sh qolsa, avtomatik tayyorlanadi."));
  const form=node("form"),grid=node("div","pv-grid"),inputs={};
  const specs=[["count","To‘plamdagi dona soni",true],["sku","SKU · ixtiyoriy"],["label_uz","Variant nomi · UZ"],["label_ru","Variant nomi · RU"],["note_uz","Qo‘shimcha izoh · UZ"],["note_ru","Qo‘shimcha izoh · RU"]];
  for(const [key,title,numeric] of specs){
   const box=node("div","pv-field"),lab=node("label","",title),input=node(key.startsWith("note_")?"textarea":"input");
   input.id="pv-field-"+(++fieldNo);lab.htmlFor=input.id;input.name=key;input.value=draft[key];
   if(numeric){input.type="number";input.min="1";input.max="9999";input.step="1";input.required=true;}
   else{input.maxLength=key==="sku"?64:key.startsWith("note_")?240:60;if(key.startsWith("note_"))input.rows=2;}
   if(key==="sku"){input.placeholder="Avtomatik SKU";input.spellcheck=false;}
   if(key.startsWith("note_"))input.placeholder=key.endsWith("uz")?"Masalan: qora rang, 1,5 m kabel":"Например: чёрный цвет, кабель 1,5 м";
   inputs[key]=input;box.append(lab,input);grid.appendChild(box);
  }
  let previousCount=draft.count;
  inputs.count.addEventListener("input",()=>{for(const lang of ["uz","ru"]){const suffix=lang==="uz"?" dona":" шт.",input=inputs["label_"+lang];if(input.value===previousCount+suffix)input.value=inputs.count.value+suffix;}previousCount=inputs.count.value;});
  const error=node("p","pv-error");error.setAttribute("role","alert");
  const actions=node("div","pv-dialog-actions"),cancel=button("Bekor qilish",()=>dialog.close()),save=node("button","pv-primary",isNew?"Qo‘shish":"Saqlash");save.type="submit";actions.append(cancel,save);form.append(grid,error,actions);dialog.appendChild(form);
  form.addEventListener("submit",e=>{
   e.preventDefault();const row={count:Number(inputs.count.value)};for(const key of keys)row[key]=inputs[key].value.trim();
   const next=items.map(v=>({...v}));if(isNew)next.push(row);else next[index]=row;
   try{const normalized=normalize(next);validate(normalized);undo=null;commit(normalized);dialog.close();}catch(e){error.textContent=e.message;}
  });
  const opener=document.activeElement;dialog.addEventListener("close",()=>{dialog.remove();if(opener&&opener.isConnected)opener.focus();else container.querySelector("button")?.focus();});
  document.body.appendChild(dialog);dialog.showModal();inputs.count.focus();
 }
 function draw(){
  container.replaceChildren();const list=node("div","pv-list");
  items.forEach((v,i)=>{
   const row=node("article","pv-item"),top=node("div","pv-item-top"),info=node("div","pv-item-info");
   info.append(node("strong","",label(v,"uz")),node("span","pv-translation",label(v,"ru")),node("code","pv-sku",v.sku||"SKU avtomatik tayyorlanadi"));
   top.append(info,node("span","pv-number",String(i+1).padStart(2,"0")));row.appendChild(top);
   if(v.note_uz||v.note_ru)row.appendChild(node("p","pv-notes",[v.note_uz,v.note_ru].filter(Boolean).join(" / ")));
   const acts=node("div","pv-actions");
   acts.append(button("Tahrirlash",()=>edit(i)),button("O‘chirish",()=>{if(disabled)return;if(items.length===1){const msg=container.querySelector(".pv-status");msg.textContent="Kamida bitta variant qolishi kerak. Yangi variant qo‘shib, keyin buni o‘chiring.";return;}undo=items.map(x=>({...x}));commit(items.filter((_,k)=>k!==i));},"pv-delete"));
   if(opts.onCopy)acts.appendChild(button("Nusxalash",()=>opts.onCopy(i)));
   row.appendChild(acts);list.appendChild(row);
  });
  const add=button("+ Variant qo‘shish",()=>edit(null),"pv-add");add.disabled=disabled||items.length>=MAX;
  const status=node("p","pv-status");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  container.append(list,add,status);
  if(undo){const restore=button("O‘chirilgan variantni qaytarish",()=>{const prior=undo;undo=null;commit(prior);},"pv-undo");container.appendChild(restore);}
  container.querySelectorAll("button").forEach(b=>{if(disabled)b.disabled=true;});
 }
 draw();return {get:()=>validate(normalize(items)),setDisabled:value=>{disabled=value;draw();}};
}
window.PackVariants={defaults,normalize,validate,assignSkus,label,blocks,shortText,editor};
})();
