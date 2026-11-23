/* Shared by the generator and its standalone exports. No API keys or network API calls here. */
(function () {
"use strict";
const imageTitles = ["Asosiy rasm","Xususiyatlar","Komplektatsiya"];
const methods={uzum_html:"Uzum sahifasi",uzum_public_api:"Uzum mahsulot ma’lumotlari",uzum_graphql:"Uzum mahsulot ma’lumotlari",openai_web:"Uzum havolasidan olingan veb-parchalar",manual:"Sotuvchi kiritgan matn",external_html:"Mahsulot sayti",external_web:"Havoladan olingan veb-parchalar",external_manual:"Sotuvchi kiritgan matn",demo:"Demo · shartli ma’lumotlar"};
const evidenceLabels={title:"nom",description:"tavsif",attributes:"xususiyat","meta keywords":"meta keywords"};
let card, host, apiTicket="", timer, mediaRevision=0;
function cardOptions(){const opts=card.options||(card.options={level:"2",stickers:true,symbols:true,copywriting:true,images:true,pro_infographic:false});if(opts.properties===undefined)opts.properties=true;return opts;}
function clearPosters(){card.posters=[];card.pro_png="";card.pro_pngs=[];card.media_meta=null;mediaRevision++;}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function button(text,action,cls){const b=el("button",cls,text);b.type="button";b.addEventListener("click",action);return b;}
function downloadLink(title,url,filename){const a=el("a","ce-btn",title);a.href=url;a.download=filename;return a;}
function section(label){const s=el("section");s.appendChild(el("h2","",label));host.appendChild(s);return s;}
function note(s,text){s.appendChild(el("p","ce-note",text));}
function status(text){let n=document.getElementById("ce-popup");if(!n){n=el("div","ce-popup");n.id="ce-popup";n.setAttribute("role","status");document.body.appendChild(n);}n.textContent=text;n.hidden=false;clearTimeout(timer);timer=setTimeout(()=>{n.hidden=true;},3000);}
function manualCopy(text){const dialog=el("dialog","ce-dialog");dialog.appendChild(el("p","","Matn belgilandi. Ctrl+C yoki ⌘C bosing. Telefonda belgilangan matnni nusxalang."));const t=el("textarea");t.readOnly=true;t.value=text;dialog.appendChild(t);dialog.appendChild(button("Yopish",()=>dialog.close()));dialog.addEventListener("close",()=>dialog.remove());document.body.appendChild(dialog);dialog.showModal();t.focus();t.select();}
function escapeText(text){return String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function richParagraphs(text){return text.split(/\n\s*\n/).map(p=>"<p>"+escapeText(p).replace(/\n/g,"<br>")+"</p>").join("");}
async function copyText(text,rich){if(!text.trim())return;try{if(rich&&navigator.clipboard&&navigator.clipboard.write&&window.ClipboardItem){await navigator.clipboard.write([new ClipboardItem({"text/plain":new Blob([text],{type:"text/plain"}),"text/html":new Blob([richParagraphs(text)],{type:"text/html"})})]);}else if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);}else throw Error();status("Nusxalandi ✓");}catch(e){manualCopy(text);}}
let fieldId=0;
function field(s,label,obj,key,opts){opts=opts||{};const box=el("div","ce-field"),line=el("div","ce-line"),lab=el("label");const id="ce-field-"+(++fieldId);lab.htmlFor=id;if(opts.lang)lab.appendChild(el("span","ce-badge",opts.lang));lab.appendChild(document.createTextNode(label));line.appendChild(lab);const act=el("div","ce-buttons");const cp=button("Nusxalash",()=>copyText(input.value,false));act.appendChild(cp);if(opts.rich)act.appendChild(button("Format bilan",()=>copyText(input.value,true),"ce-p"));line.appendChild(act);box.appendChild(line);const input=el(opts.rows?"textarea":"input");input.id=id;input.value=typeof obj[key]==="string"?obj[key]:"";if(opts.rows)input.rows=opts.rows;if(opts.max)input.maxLength=opts.max;if(opts.placeholder)input.placeholder=opts.placeholder;box.appendChild(input);const counter=el("div","ce-count");if(opts.max)box.appendChild(counter);function update(){obj[key]=input.value;counter.textContent=input.value.length+" / "+(opts.max||"");cp.disabled=!input.value.trim();}input.addEventListener("input",update);update();s.appendChild(box);return input;}
function chipList(parent,values){const list=el("div","ce-chiplist");for(const value of values){const chip=el("span","ce-chip",typeof value==="string"?value:value.term);if(typeof value==="object")chip.appendChild(el("small","ce-evidence",evidenceLabels[value.field]||value.field));list.appendChild(chip);}parent.appendChild(list);}
function initVariants(){
 if(!Array.isArray(card.variants)){
  const counts=Array.isArray(card.pack_counts)&&card.pack_counts.length?card.pack_counts:[1,2];
  card.variants=counts.map((count,i)=>({count,label_uz:count+" dona",label_ru:count+" шт.",sku:(card.skus||[])[i]||"",note_uz:"",note_ru:""}));
 }
 card.sku_root=card.sku_root||String((card.skus||[])[0]||"UZ-"+(card.source.id||"MAHSULOT")).replace(/-\d+$/,"");
 card.variants=PackVariants.assignSkus(card.variants,card.sku_root);
 card.pack_counts=card.variants.map(v=>v.count);card.skus=card.variants.map(v=>v.sku);
}
function packText(i){const v=card.variants[i];return [
 "Variant · UZ: "+PackVariants.label(v,"uz"),"Вариант · RU: "+PackVariants.label(v,"ru"),"SKU: "+v.sku,
 "Komplektatsiya / Комплектация: "+v.count+" × "+card.source.title,
 v.note_uz?"Izoh · UZ: "+v.note_uz:"",v.note_ru?"Примечание · RU: "+v.note_ru:""].filter(Boolean).join("\n");}
function syncVariantText(){
 const previous=card.variant_text_blocks||{};if(!card.variant_text_blocks)card.variant_text_review=true;
 const next={};
 for(const lang of ["uz","ru"]){
  next[lang]=PackVariants.blocks(card.variants,lang);
  for(const key of ["short","full","composition"]){
   const old=previous[lang]&&previous[lang][key];let text=card[lang][key]||"";
   if(old&&text.includes(old))text=text.replace(old,"").trim();
   else if(old)card.variant_text_review=true;
   const sep=key==="short"?" ":"\n\n",block=next[lang][key],limit=key==="short"?390:28000;
   let base=text.slice(0,Math.max(0,limit-block.length-sep.length)).trimEnd();
   if(/[\uD800-\uDBFF]$/.test(base))base=base.slice(0,-1);
   card[lang][key]=[base,block].filter(Boolean).join(sep);
  }
 }
 card.variant_text_blocks=next;
}
function updateCardVariants(items){
 const old=JSON.stringify(card.variants.map(({sku,...rest})=>rest));
 card.variants=items;initVariants();
 if(old!==JSON.stringify(card.variants.map(({sku,...rest})=>rest))){
  syncVariantText();clearPosters();card.media_note="Variantlar yangilandi. Rasm tayyorlash uchun mahsulot surati kerak.";
 }
 const target=card;render(host,card,apiTicket);
 if(cardOptions().images&&card.photo&&!card.posters.length){createPosters(card.photo).then(()=>{if(card===target)refreshMedia();}).catch(e=>{if(card===target){card.media_note=e.message;refreshMedia();}});}
 status("Sotuv variantlari saqlandi. HTMLni yuklab olish orqali faylga saqlang.");
}
function variantCaption(lang){return card.variants.map(v=>PackVariants.label(v,lang)).join(" / ");}
function paintVariantBand(ctx,x,y,w,h,dark){
 const text=variantCaption("ru");rounded(ctx,x,y,w,h,20,dark?"#112b3b":"#eee5fb");
 fit(ctx,text.length<=160?text:card.variants.length+" вариантов комплекта. Выберите нужный в карточке.",x+25,y+18,w-50,h-36,36,"bold",dark?"#fff":"#452573");
}
function paintVariantGrid(ctx,x,y,w,h,accent){
 const columns=card.variants.length===1?1:card.variants.length<=4?2:3,rows=Math.ceil(card.variants.length/columns),gap=14,cw=(w-gap*(columns-1))/columns,ch=(h-gap*(rows-1))/rows;
 card.variants.forEach((v,i)=>{const px=x+(i%columns)*(cw+gap),py=y+Math.floor(i/columns)*(ch+gap);rounded(ctx,px,py,cw,ch,18,accent||(i%2?"#6734c7":"#282236"));fit(ctx,PackVariants.label(v,"ru"),px+18,py+16,cw-36,ch-32,rows>2?28:44,"bold",readable(accent||"#282236"));});
}
function sourcePanel(){
 const s=section("Tovar toifasi va manba");field(s,"Tovar toifasi",card.source,"category",{placeholder:"Uzum kabinetidagi mos toifani tanlang"});
 const line=el("div","ce-top");line.append(el("div","ce-source-title",card.source.title),el("span","ce-source-method",methods[card.source.method]||"Manba"));s.appendChild(line);
 if(card.source.method!=="demo"&&/^https?:\/\//.test(card.source.url||"")){const link=el("a","",card.source.mode==="external"?"Manba mahsulotini ochish ↗":"Uzum kartochkasini ochish ↗");link.href=card.source.url;link.target="_blank";link.rel="noopener noreferrer";s.appendChild(link);}
 if(card.source.method==="demo")note(s,"Bu shartli demo. Matn va xususiyatlar haqiqiy mahsulot haqida ma’lumot emas; demo API sarflamaydi.");
 else s.appendChild(el("p","ce-flags",card.source.mode==="external"?"Manba sayt: "+(card.source.host||""):"Mahsulot ID "+card.source.id+(card.source.sku?" · Manba SKU "+card.source.sku:"")));
 if(card.source.source_category)note(s,"Manbadagi toifa: "+card.source.source_category+". Uzumdagi mos toifani yuqorida kiriting.");
 if(card.ai_model)note(s,"Kartochkani tayyorlagan model: "+card.ai_model);
 if(card.detail_title)note(s,"Daraja: "+card.detail_title+" · "+(card.detail_range||""));
 if(card.detail_note)note(s,card.detail_note);
 const opts=cardOptions();note(s,"Stiker: "+(opts.stickers?"yoqilgan":"o‘chirilgan")+" · Belgilar: "+(opts.symbols?"yoqilgan":"o‘chirilgan")+" · Matn: "+(opts.copywriting?"kopirayting":"neytral tavsif")+" · Xususiyatlar: "+(opts.properties?"yoqilgan":"o‘chirilgan"));
 if(card.source.sku_note)note(s,card.source.sku_note);
 const d=el("details");d.append(el("summary","","O‘qilgan manba matni"),el("div","ce-evid",[card.source.title,card.source.description,card.source.attributes].filter(Boolean).join("\n\n")));s.appendChild(d);
}
function renderSEO(){
 if(!card.seo_enabled)return;
 const s=section("SEO · tekshirilgan kalit so‘zlar"),terms=(card.source_terms||[]).slice(0,4);
 s.appendChild(el("p","ce-seo-title",card.seo_note||terms.length+" ta kalit so‘z manba bilan solishtirildi."));
 if(terms.length){
  const list=el("div","ce-seo-results");
  for(const t of terms){const row=el("article","ce-seo-item");row.append(el("b","",t.term),el("span","ce-verified","✓ Manbada bor · "+(evidenceLabels[t.field]||t.field)));if(t.evidence)row.appendChild(el("p","ce-seo-quote",t.evidence));list.appendChild(row);}
  s.append(list,button("Tekshirilgan so‘zlarni nusxalash",()=>copyText(terms.map(x=>x.term).join(", "),false)));
 }else note(s,"Manbada tasdiqlangan kalit so‘z topilmadi.");
 const d=el("details");d.appendChild(el("summary","","UZ / RU uchun AI takliflari"));
 for(const lang of ["uz","ru"]){const values=(card[lang].keyword_suggestions||[]).slice(0,4);d.appendChild(el("p","ce-seo-title",lang.toUpperCase()));if(values.length){chipList(d,values);d.appendChild(button("Takliflarni nusxalash · "+lang.toUpperCase(),()=>copyText(values.join(", "),false)));}else note(d,"Qo‘shimcha taklif yo‘q.");}s.appendChild(d);
 note(s,"Tekshiruv mahsulotga moslik, takrorlanish va o‘qilgan manba matniga asoslanadi. Qidiruvlar soni yoki reyting o‘lchanmaydi. AI takliflari manbadan tasdiqlangan iboralar hisoblanmaydi.");
}
function renderProperties(){
 const s=section(cardOptions().properties?"Xususiyatlar va sotuv variantlari":"Sotuv variantlari");s.id="ce-variants";
 const pills=el("div","ce-pack-pills");card.variants.forEach(v=>pills.appendChild(el("span","",PackVariants.label(v,"uz"))));s.appendChild(pills);
 note(s,"Dona soni, UZ/RU nomi, SKU va qo‘shimcha izohlarni tahrirlang. Yangi variant qo‘shish va o‘chirish mumkin.");
 const editor=el("div");s.appendChild(editor);PackVariants.editor(editor,card.variants,updateCardVariants,{skuBase:card.sku_root,onCopy:i=>copyText(packText(i),false)});
 if(card.variant_text_review)s.appendChild(el("p","ce-variant-warning","Avvalgi matnda variant izohi qo‘lda o‘zgartirilgan yoki eski formatda saqlangan. Nom, tavsif va tarkibdagi eski to‘plam ma’lumotlarini tekshirib tahrirlang."));
 for(const lang of ["uz","ru"]){
  const items=cardOptions().properties?(card[lang].properties||[]):[];if(!items.length)continue;
  const d=el("details");d.appendChild(el("summary","","Texnik xususiyatlar · "+lang.toUpperCase()));
  items.forEach(item=>{const grid=el("div","ce-grid");field(grid,"Xususiyat",item,"label");field(grid,"Qiymat",item,"value");d.appendChild(grid);});s.appendChild(d);
 }
 if(!cardOptions().properties)note(s,"Xususiyatlar jadvalini yaratish o‘chirilgan. Sotuv variantlarini boshqarish mumkin.");
 note(s,"Narx va qoldiqni har bir SKU uchun Uzum kabinetida alohida kiriting.");
}
function mediaToggle(parent,label,checked,handler){
 const line=el("label","ce-toggle"),input=el("input");input.type="checkbox";input.checked=checked;line.append(el("span","",label),input);parent.appendChild(line);
 input.addEventListener("change",async()=>{input.disabled=true;try{await handler(input.checked);}catch(e){status(e.message||"Rasm tayyorlanmadi.");}finally{refreshMedia();}});return input;
}
function renderMedia(){
 const s=section("Tovar umumiy rasmlari");s.id="ce-media";const opts=cardOptions(),switches=el("div","ce-media-switches");s.appendChild(switches);
 mediaToggle(switches,"Rasmlarni yoqish",opts.images,async checked=>{opts.images=checked;clearPosters();if(checked&&card.photo)await createPosters(card.photo);});
 if(!opts.images){note(s,"Rasmlar o‘chirilgan. Eksportga mahsulot surati va infografikalar kiritilmaydi.");return;}
 mediaToggle(switches,"PRO infografika",opts.pro_infographic,async checked=>{opts.pro_infographic=checked;clearPosters();if(card.photo)await createPosters(card.photo);});
 const imageOptions=imageSettings(),countRow=el("div","ce-media-count"),countLabel=el("label","","Rasm soni"),countInput=el("input");
 countInput.id="ce-image-count";countLabel.htmlFor=countInput.id;countInput.type="number";countInput.min="1";countInput.max="10";countInput.step="1";countInput.value=imageOptions.count;
 countRow.append(countLabel,countInput,button("Rasm sonini qo‘llash",async()=>{try{const next=ImageTools.settings({count:Number(countInput.value),prompt:imageOptions.prompt});card.image_settings={...card.image_settings,...next};clearPosters();if(card.photo)await createPosters(card.photo);else card.media_note="Rasm soni saqlandi. Mahsulot suratini tanlang.";refreshMedia();status("Rasm soni saqlandi");}catch(e){status(e.message);}}));s.appendChild(countRow);
 if(imageOptions.prompt){const d=el("details");d.append(el("summary","","Rasm uchun ishlatilgan prompt"),el("p","ce-image-prompt",imageOptions.prompt));note(d,"Yangi promptni qo‘llash uchun asosiy oynadagi rasm sozlamalarini tahrirlang va kartochkani qayta tayyorlang.");s.appendChild(d);}
 if(card.image_design&&card.image_design.note)note(s,card.image_design.note);
 const pro=opts.pro_infographic,productOnly=!pro&&card.image_mode==="product",gallery=el("div","ce-gallery"+(pro?" ce-pro-gallery":""));s.appendChild(gallery);
 if(Array.isArray(card.posters)&&card.posters.length){
  card.posters.forEach((src,i)=>{const tile=el("article","ce-image"),im=el("img");im.alt=(pro?"PRO infografika":productOnly?"Mahsulot":"Infografika")+" · "+(i+1);im.src=src;im.loading="lazy";tile.append(im,el("b","",im.alt));
   const png=(card.pro_pngs||[])[i]||(i===0?card.pro_png:"");if(pro&&png)tile.appendChild(downloadLink("PNG master · 2160 × 2880 ↓",png,"Uzum_"+card.source.id+"_PRO_"+(i+1)+"_2160x2880.png"));
   tile.appendChild(downloadLink(pro?"JPG · 1080 × 1440 ↓":"JPG yuklash ↓",src,"Uzum_"+card.source.id+"_0"+(i+1)+".jpg"));gallery.appendChild(tile);
  });
  if(pro){const info=el("div","ce-pro-info");info.append(el("span","ce-pro-tag","PRO / "+card.posters.length+" RASM"),el("h3","","Aniq mahsulot. Aniq ma’lumot."),el("p","","2160 × 2880 PNG master: siqishda sifat yo‘qotilmaydigan format. 1080 × 1440 JPG: yuklash uchun ixcham nusxa."),el("p","","Har bir rasm uchun PNG va JPG mavjud. Mahsulot asl suratdan olinadi; do‘kon nomi yoki suv belgisi qo‘shilmaydi."),el("p","","Nom yoki xususiyatlarni tahrirlasangiz, «Rasmlarni yangilash»ni bosing."));gallery.appendChild(info);}
  else note(s,productOnly?card.posters.length+" ta matnsiz kompozitsiya · 1080 × 1440 px.":card.posters.length+" ta ruscha infografika · 1080 × 1440 px · do‘kon yozuvisiz.");
 }else s.appendChild(el("div","ce-placeholder",card.media_note||"Rasmlar uchun mahsulotning asl suratini tanlang."));
 if(card.media_meta&&card.media_meta.quality_note)note(s,card.media_meta.quality_note);
 if(card.photo){const preview=el("div","ce-product-preview"),im=el("img");im.src=card.photo;im.alt="Ajratilgan mahsulot surati";preview.append(im,el("p","ce-note","Ishlatilgan mahsulot qismi. Chegarani «Mahsulotni ajratish» orqali sozlang."));s.appendChild(preview);}
 const tools=el("div","ce-media-tools"),file=el("input");file.type="file";file.accept="image/jpeg,image/png,image/webp";file.hidden=true;
 file.addEventListener("change",async()=>{if(!file.files.length)return;try{const f=file.files[0];if(f.size>12*1024*1024)throw Error("12 MB dan kichik rasm tanlang.");await cropDialog(await readData(f));}catch(e){status(e.message||"Rasm ochilmadi");}finally{file.value="";}});
 tools.append(file,button("Surat tanlash",()=>file.click()));
 if(apiTicket&&card.source.photos.length){const sel=el("select");sel.setAttribute("aria-label","Manbadagi suratni tanlash");card.source.photos.forEach((url,i)=>{const opt=el("option","","Manba surati "+(i+1));opt.value=String(i);sel.appendChild(opt);});tools.append(sel,button("Manbadan mahsulotni ajratish",async()=>{try{await postersFromTicket(apiTicket,Number(sel.value));}catch(e){status(e.message);}}));}
 if(card.photo){
  if(!pro){const mode=el("select");mode.setAttribute("aria-label","Natijadagi rasmlar ko‘rinishi");for(const [value,label] of [["infographic","Ruscha infografika"],["product","Faqat mahsulot · matnsiz"]]){const opt=el("option","",label);opt.value=value;mode.appendChild(opt);}mode.value=card.image_mode||"infographic";mode.addEventListener("change",async()=>{try{card.image_mode=mode.value;await createPosters(card.photo);refreshMedia();}catch(e){status(e.message);}});tools.appendChild(mode);}
  tools.append(button("Mahsulotni ajratish",()=>cropDialog(card.original_photo||card.photo,card.original_photo?card.photo_crop:null).catch(e=>status(e.message))),button("Rasmlarni yangilash",async()=>{try{await createPosters(card.photo);refreshMedia();status("Rasmlar yangilandi");}catch(e){status(e.message);}}),button("Surat va rasmlarni olib tashlash",()=>{clearPosters();card.photo="";card.original_photo="";card.photo_crop=null;card.photo_method="";card.media_note="Surat va tayyor rasmlar olib tashlandi.";refreshMedia();}));
 }
 s.appendChild(tools);note(s,"Yozuv mahsulot ustini yopsa, yozuvsiz asl surat tanlang. Past aniqlikdagi suratni kattalashtirish yangi detal qo‘shmaydi.");
}
function refreshMedia(){const prev=host.querySelector("#ce-media");if(!prev)return;const after=prev.nextSibling;prev.remove();renderMedia();host.insertBefore(host.lastElementChild,after);}
function render(container,data,ticket){card=data;initVariants();host=container;apiTicket=ticket||"";fieldId=0;host.replaceChildren();host.classList.add("ce");sourcePanel();let s=section("Tovar nomi");for(const lang of ["uz","ru"])field(s,"Tovar nomi",card[lang],"title",{lang:lang.toUpperCase(),max:90});
 s=section("Ishlab chiqarilgan mamlakat, brend, model va kafolat");const g=el("div","ce-grid");for(const [key,label] of [["country","Ishlab chiqarilgan mamlakat"],["brand","Brend"],["model","Model"],["warranty","Kafolat (oy)"],["color_uz","Rang · UZ"],["color_ru","Rang · RU"]])field(g,label,card,key,{placeholder:"Tasdiqlangandan so‘ng kiriting"});s.appendChild(g);
 s=section("Tovar qisqacha tavsifi");for(const lang of ["uz","ru"])field(s,"Qisqacha tavsif",card[lang],"short",{lang:lang.toUpperCase(),rows:3,max:390});
 s=section("Tovar tavsifi");for(const lang of ["uz","ru"])field(s,"To‘liq tavsif",card[lang],"full",{lang:lang.toUpperCase(),rows:9,max:28000,rich:true});
 renderMedia();renderProperties();
 s=section("Tarkib");for(const lang of ["uz","ru"])field(s,"Tarkib va komplektatsiya",card[lang],"composition",{lang:lang.toUpperCase(),rows:3});
 s=section("Foydalanish bo‘yicha yo‘riqnoma");for(const lang of ["uz","ru"])field(s,"Yo‘riqnoma",card[lang],"instructions",{lang:lang.toUpperCase(),rows:4,placeholder:"Manbada keltirilgan yo‘riqnomani kiriting"});
 s=section("Qo‘shimcha media va hujjatlar");note(s,"Video, 360° rasm va sertifikatni mahsulotga tegishli fayl bo‘lsa kabinetga qo‘shing. Qadoq o‘lchamlari va og‘irligini har bir to‘plam uchun alohida kiriting.");
 renderSEO();s=section("Kartochkani saqlash");const row=el("div","ce-action-row");row.append(button("Barcha matnlarni nusxalash",()=>copyText(allText(),false)));const a=el("a","ce-btn ce-p","HTMLni yuklab olish ↓");a.href="#";a.download=fileName();a.addEventListener("click",saveExport);row.appendChild(a);s.appendChild(row);
}
function allText(){const out=[card.source.title,"Manba: "+card.source.url,"Toifa: "+card.source.category];for(const key of ["country","brand","model","warranty"])if(card[key])out.push(({country:"Mamlakat",brand:"Brend",model:"Model",warranty:"Kafolat"})[key]+": "+card[key]);for(const lang of ["uz","ru"]){const v=card[lang];out.push(lang.toUpperCase(),v.title,v.short,v.full,v.composition,v.instructions,cardOptions().properties?(v.properties||[]).map(p=>p.label+": "+p.value).join("\n"):"");}card.variants.forEach((v,i)=>out.push(packText(i)));if(card.seo_enabled)out.push("Manba SEO\n"+card.source_terms.map(x=>x.term).join(", "),"AI SEO UZ\n"+card.uz.keyword_suggestions.join(", "),"AI SEO RU\n"+card.ru.keyword_suggestions.join(", "));return out.filter(Boolean).join("\n\n");}
function readData(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error("Rasm o‘qilmadi."));reader.readAsDataURL(blob);});}
function loadPhoto(url){return new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>{if(im.naturalWidth*im.naturalHeight>50000000)reject(Error("Rasm juda katta."));else resolve(im);};im.onerror=()=>reject(Error("Suratni ochib bo‘lmadi."));im.src=url;});}
function wrapLines(ctx,text,width){const result=[];for(const block of String(text).split(/\n/)){let line="";for(const word of block.split(/\s+/).filter(Boolean)){if(ctx.measureText(word).width>width){if(line){result.push(line);line="";}let part="";for(const ch of word){if(part&&ctx.measureText(part+ch).width>width){result.push(part);part=ch;}else part+=ch;}line=part;continue;}if(line&&ctx.measureText(line+" "+word).width>width){result.push(line);line=word;}else line+=(line?" ":"")+word;}if(line)result.push(line);}return result;}
function fit(ctx,text,x,y,w,h,size,weight,color){let font=size,lines=[];while(font>=20){ctx.font=weight+" "+font+"px Arial, sans-serif";lines=wrapLines(ctx,text,w);if(lines.length*font*1.18<=h)break;font-=2;}const max=Math.max(1,Math.floor(h/(font*1.18)));if(lines.length>max){lines=lines.slice(0,max);let l=lines[max-1];while(l&&ctx.measureText(l+"…").width>w)l=l.slice(0,-1);lines[max-1]=l+"…";}ctx.fillStyle=color;ctx.textBaseline="top";lines.forEach((l,i)=>ctx.fillText(l,x,y+i*font*1.18));}
function rounded(ctx,x,y,w,h,r,color){ctx.fillStyle=color;ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h);ctx.fill();}
function photoBox(ctx,img,x,y,w,h){rounded(ctx,x,y,w,h,26,"#ffffff");const scale=Math.min((w-24)/img.naturalWidth,(h-24)/img.naturalHeight);const dw=img.naturalWidth*scale,dh=img.naturalHeight*scale;ctx.drawImage(img,x+(w-dw)/2,y+(h-dh)/2,dw,dh);}
function proIcon(ctx,x,y){
 ctx.save();ctx.strokeStyle="#147d86";ctx.lineWidth=3;ctx.lineCap="round";ctx.beginPath();ctx.arc(x+16,y+16,16,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(x+9,y+16);ctx.lineTo(x+14,y+21);ctx.lineTo(x+23,y+11);ctx.stroke();ctx.restore();
}
function imageSettings(){
 if(!card.image_settings)card.image_settings={count:(card.posters||[]).length||(cardOptions().pro_infographic?1:3),prompt:""};
 return ImageTools.settings(card.image_settings);
}
function readable(hex){const values=hex.slice(1).match(/../g).map(x=>parseInt(x,16));return values[0]*.299+values[1]*.587+values[2]*.114>160?"#192136":"#ffffff";}
function paintComposition(img,plan,index,pro){
 const factor=pro?2:1,master=document.createElement("canvas");master.width=1080*factor;master.height=1440*factor;
 const ctx=master.getContext("2d");ctx.scale(factor,factor);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality="high";
 ctx.fillStyle=plan.background;ctx.fillRect(0,0,1080,1440);
 const ink=readable(plan.background),accentInk=readable(plan.accent),features=(cardOptions().properties?(card.ru.properties||[]):[]).filter(p=>p.label&&p.value).slice(0,3);
 const noText=(!pro&&card.image_mode==="product")||plan.text_mode==="none",minimal=plan.text_mode==="minimal";
 let photoBoxSize={width:952,height:960};
 function photo(x,y,w,h){const scale=plan.photo_scale;w*=scale;h*=scale;photoBoxSize={width:(w-24)*factor,height:(h-24)*factor};photoBox(ctx,img,x+(1-scale)*w/(2*scale),y+(1-scale)*h/(2*scale),w,h);}
 function property(x,y,w,h,item){rounded(ctx,x,y,w,h,18,"#ffffff");fit(ctx,item.label,x+22,y+18,w-44,50,25,"normal","#596273");fit(ctx,item.value,x+22,y+77,w-44,h-92,36,"bold","#18263a");}
 function band(){rounded(ctx,64,1260,952,116,22,plan.accent);const caption=variantCaption("ru");fit(ctx,caption.length<=160?caption:card.variants.length+" вариантов комплекта. Выберите нужный в карточке.",90,1280,900,76,33,"bold",accentInk);}
 if(noText){
  const boxes={hero:[64,80,952,1280],split_left:[64,150,820,1140],split_right:[196,150,820,1140],features:[88,200,904,1040],pack:[112,200,856,1040]},box=boxes[plan.layout]||boxes.hero;
  photo(...box);
 }else{
  rounded(ctx,64,52,90,8,4,plan.accent);fit(ctx,card.ru.title,64,96,952,210,66,"bold",ink);
  if(minimal){const side=plan.layout==="split_left"||plan.layout==="split_right";photo(plan.layout==="split_right"?196:64,340,side?820:952,1000);}
  else if(plan.layout==="split_left"||plan.layout==="split_right"){
   const left=plan.layout==="split_left",px=left?64:442,tx=left?664:64;
   photo(px,350,574,820);
   if(features.length)features.forEach((f,k)=>property(tx,350+k*269,352,250,f));
   else{rounded(ctx,tx,350,352,820,20,"#ffffff");fit(ctx,card.ru.short,tx+24,380,304,750,34,"normal","#243044");}
   band();
  }else if(plan.layout==="features"){
   photo(64,330,952,510);
   if(features.length)features.forEach((f,k)=>{rounded(ctx,64,875+k*120,952,106,18,"#ffffff");fit(ctx,f.label,88,899+k*120,365,66,28,"normal","#586275");fit(ctx,f.value,485,895+k*120,505,74,34,"bold","#18263a");});
   else fit(ctx,card.ru.short,64,880,952,330,40,"normal",ink);
   band();
  }else if(plan.layout==="pack"){
   photo(64,330,952,565);paintVariantGrid(ctx,64,935,952,311,plan.accent);fit(ctx,"Количество зависит от выбранного варианта.",64,1294,952,88,31,"normal",ink);
  }else{
   photo(64,340,952,features.length?650:880);
   if(features.length){const gap=16,w=(952-gap*(features.length-1))/features.length;features.forEach((f,k)=>property(64+k*(w+gap),1024,w,202,f));}
   band();
  }
 }
 let web=master;
 if(pro){web=document.createElement("canvas");web.width=1080;web.height=1440;const c=web.getContext("2d");c.imageSmoothingEnabled=true;c.imageSmoothingQuality="high";c.drawImage(master,0,0,1080,1440);}
 return {png:pro?master.toDataURL("image/png"):"",jpg:web.toDataURL("image/jpeg",pro?.96:.92),photo_box:photoBoxSize};
}
async function createPosters(dataURL){
 if(!/^data:image\/(jpeg|png|webp);base64,/i.test(dataURL))throw Error("JPG, PNG yoki WebP surat kerak.");
 const target=card,revision=++mediaRevision;if(!cardOptions().images){clearPosters();return false;}
 const settings=imageSettings(),designs=ImageTools.plans(settings.count,card.image_design),img=await loadPhoto(dataURL);
 if(card!==target||revision!==mediaRevision||!cardOptions().images)return false;
 const mini=document.createElement("canvas"),scale=Math.min(1,3200/Math.max(img.naturalWidth,img.naturalHeight));mini.width=Math.max(1,Math.round(img.naturalWidth*scale));mini.height=Math.max(1,Math.round(img.naturalHeight*scale));
 const mc=mini.getContext("2d");mc.fillStyle="white";mc.fillRect(0,0,mini.width,mini.height);mc.drawImage(img,0,0,mini.width,mini.height);
 const pictures=[],masters=[];let scaleNeeded=1;
 for(let i=0;i<settings.count;i++){
  if(card!==target||revision!==mediaRevision||!cardOptions().images)return false;
  const rendered=paintComposition(img,designs[i],i,cardOptions().pro_infographic);pictures.push(rendered.jpg);if(rendered.png)masters.push(rendered.png);
  scaleNeeded=Math.max(scaleNeeded,Math.min(rendered.photo_box.width/img.naturalWidth,rendered.photo_box.height/img.naturalHeight));
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 if(card!==target||revision!==mediaRevision||!cardOptions().images)return false;
 card.photo=scale===1?dataURL:mini.toDataURL("image/jpeg",.98);card.posters=pictures;card.pro_pngs=masters;card.pro_png=masters[0]||"";card.media_note="";
 card.image_settings={...card.image_settings,...settings};card.image_design={...card.image_design,plans:designs};
 card.media_meta={width:masters.length?2160:1080,height:masters.length?2880:1440,count:pictures.length,photo_width:img.naturalWidth,photo_height:img.naturalHeight,quality_note:"Mahsulot qismi: "+img.naturalWidth+" × "+img.naturalHeight+" px."+(scaleNeeded>1.25?" Yanada tiniq natija uchun kattaroq asl surat yuklang.":"")};return true;
}
function cropBounds(rect){
 const r=rect||{x:0,y:0,width:1,height:1};
 if(![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1.00001||r.y+r.height>1.00001)throw Error("Mahsulot chegarasini surat ichida belgilang.");
 return r;
}
async function useProductPhoto(result){
 const target=card;if(!cardOptions().images)return false;const rect=cropBounds(result.crop),img=await loadPhoto(result.photo);
 const sx=Math.floor(rect.x*img.naturalWidth),sy=Math.floor(rect.y*img.naturalHeight),sw=Math.min(img.naturalWidth-sx,Math.round(rect.width*img.naturalWidth)),sh=Math.min(img.naturalHeight-sy,Math.round(rect.height*img.naturalHeight));
 if(sw<32||sh<32)throw Error("Mahsulot qismi juda kichik. Kattaroq surat yoki chegara tanlang.");
 const cut=document.createElement("canvas"),scale=Math.min(1,3200/Math.max(sw,sh));cut.width=Math.max(1,Math.round(sw*scale));cut.height=Math.max(1,Math.round(sh*scale));const ctx=cut.getContext("2d");ctx.fillStyle="white";ctx.fillRect(0,0,cut.width,cut.height);ctx.drawImage(img,sx,sy,sw,sh,0,0,cut.width,cut.height);
 // Keep a bounded original for later recropping; no generative replacement of product pixels.
 const original=document.createElement("canvas"),os=Math.min(1,3600/Math.max(img.naturalWidth,img.naturalHeight));original.width=Math.round(img.naturalWidth*os);original.height=Math.round(img.naturalHeight*os);const oc=original.getContext("2d");oc.fillStyle="white";oc.fillRect(0,0,original.width,original.height);oc.drawImage(img,0,0,original.width,original.height);
 if(target!==card)throw Error("Kartochka o‘zgardi. Suratni yana tanlang.");
 if(!await createPosters(cut.toDataURL("image/jpeg",.98)))return false;
 card.original_photo=original.toDataURL("image/jpeg",.96);card.photo_crop=rect;card.photo_method=result.method||"manual_crop";return true;
}
async function cropDialog(dataURL,initial){
 if(!/^data:image\/(jpeg|png|webp);base64,/i.test(dataURL))throw Error("JPG, PNG yoki WebP surat tanlang.");
 const target=card,img=await loadPhoto(dataURL),dialog=el("dialog","ce-dialog ce-crop-dialog");
 dialog.append(el("h3","","Mahsulotning o‘zini ajrating"),el("p","","Surat ustida mahsulotni to‘liq qamrab oladigan to‘rtburchak chizing. Begona yozuvlar va stikerlar tashqarida qolsin. Foizli maydonlar orqali ham chegarani sozlash mumkin."));
 const canvas=el("canvas","ce-crop-canvas"),scale=Math.min(1,720/img.naturalWidth,470/img.naturalHeight);canvas.width=Math.round(img.naturalWidth*scale);canvas.height=Math.round(img.naturalHeight*scale);canvas.setAttribute("aria-label","Mahsulot chegarasini belgilash maydoni");dialog.appendChild(canvas);
 let rect={...cropBounds(initial)},anchor=null,dragging=false;const ctx=canvas.getContext("2d"),inputs={},grid=el("div","ce-crop-controls"),notice=el("p","ce-crop-notice");notice.setAttribute("role","status");
 function draw(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);ctx.fillStyle="#16102099";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.save();ctx.beginPath();ctx.rect(rect.x*canvas.width,rect.y*canvas.height,rect.width*canvas.width,rect.height*canvas.height);ctx.clip();ctx.drawImage(img,0,0,canvas.width,canvas.height);ctx.restore();ctx.strokeStyle="#b3ff7e";ctx.lineWidth=2;ctx.strokeRect(rect.x*canvas.width,rect.y*canvas.height,rect.width*canvas.width,rect.height*canvas.height);for(const k of Object.keys(inputs))inputs[k].value=String(Math.round(rect[k]*1000)/10);}
 for(const [k,label] of [["x","Chap (%)"],["y","Tepa (%)"],["width","Kenglik (%)"],["height","Balandlik (%)"]]){const l=el("label","",label),input=el("input");input.type="number";input.min="0";input.max="100";input.step="0.1";input.setAttribute("aria-label",label);inputs[k]=input;l.appendChild(input);grid.appendChild(l);input.addEventListener("change",()=>{const val=Number(input.value)/100;if(!Number.isFinite(val)){draw();return;}rect[k]=Math.max(k==="width"||k==="height"?.01:0,Math.min(1,val));rect.x=Math.min(rect.x,1-.01);rect.y=Math.min(rect.y,1-.01);rect.width=Math.min(rect.width,1-rect.x);rect.height=Math.min(rect.height,1-rect.y);draw();});}
 function point(e){const b=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))};}
 canvas.addEventListener("pointerdown",e=>{anchor=point(e);dragging=true;canvas.setPointerCapture(e.pointerId);e.preventDefault();});
 canvas.addEventListener("pointermove",e=>{if(!dragging)return;const p=point(e);rect={x:Math.min(anchor.x,p.x),y:Math.min(anchor.y,p.y),width:Math.abs(anchor.x-p.x),height:Math.abs(anchor.y-p.y)};draw();});
 canvas.addEventListener("pointerup",()=>{dragging=false;});canvas.addEventListener("pointercancel",()=>{dragging=false;});
 const controls=el("div","ce-crop-actions"),apply=button("Mahsulot qismini ishlatish",async()=>{if(target!==card){dialog.close();return;}try{apply.disabled=true;await useProductPhoto({photo:dataURL,crop:cropBounds(rect),method:"manual_crop"});dialog.close();refreshMedia();status("Mahsulot ajratildi. "+card.posters.length+" ta rasm tayyor.");}catch(e){notice.textContent=e.message;apply.disabled=false;}});
 controls.append(button("To‘liq surat",()=>{rect={x:0,y:0,width:1,height:1};draw();}),button("Bekor qilish",()=>dialog.close()),apply);dialog.append(grid,notice,controls);document.body.appendChild(dialog);dialog.addEventListener("close",()=>dialog.remove());dialog.showModal();draw();apply.focus();
}
async function postersFromTicket(ticket,index){
 const r=await fetch("/api/image?ticket="+encodeURIComponent(ticket)+"&index="+index,{cache:"no-store"});if(!r.ok)throw Error("Manba surati ochilmadi. Asl mahsulot suratini qurilmangizdan tanlang.");
 await cropDialog(await readData(await r.blob()));
}
function fileName(){return "Uzum_"+String(card.source.id).replace(/\D/g,"")+"_variantlar.html";}
function safeData(obj){return JSON.stringify(obj).replace(/</g,"\\u003c").replace(/[\u2028\u2029]/g,c=>c==="\u2028"?"\\u2028":"\\u2029");}
function exportDocument(){
 const style=document.getElementById("card-styles").textContent,runtime=document.getElementById("card-runtime").textContent;
 let brand="";try{brand=JSON.parse(document.getElementById("card-brand")?.textContent||'""');}catch(e){}if(!/^data:image\/png;base64,/.test(brand))brand="";
 const close="<"+"/script>";const payload=JSON.parse(JSON.stringify(card));
 if(!cardOptions().properties){payload.uz.properties=[];payload.ru.properties=[];}
 if(!cardOptions().images){payload.posters=[];payload.pro_png="";payload.pro_pngs=[];payload.photo="";payload.original_photo="";payload.photo_crop=null;payload.media_meta=null;}
 else if(!cardOptions().pro_infographic){payload.pro_png="";payload.pro_pngs=[];}
 // Only the finished card is exported. The generator form, seller prompt and API key are not part of this object.
 const colors="body{margin:0;background:#f1eff5;color:#24212a;font:14px/1.55 Inter,Arial,sans-serif}main{max-width:980px;margin:28px auto;padding:0 16px}header{padding:18px 24px;background:white;border-bottom:1px solid #e3dfe9}header h1{font-size:22px;margin:3px 0}header small{color:#777180}a{color:#652cdb}*{box-sizing:border-box}";
 const startup='const saved=JSON.parse(document.getElementById("saved-card").textContent);CardStudio.mount(document.getElementById("card-editor"),saved);';
 return '<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeText(card.uz.title)+'</title><style>'+colors+'</style><style id="card-styles">'+style+'</style></head><body><header><div class="card-brand-line">'+(brand?'<img class="card-brand-image" alt="SellerSmart" src="'+escapeText(brand)+'">':'')+'SellerSmart · Uzum kartochkasi</div><h1>'+escapeText(card.uz.title)+'</h1><small>UZ / RU · '+escapeText(variantCaption("uz"))+'</small></header><main><div id="card-editor"></div></main><script id="card-brand" type="application/json">'+safeData(brand)+close+'<script id="saved-card" type="application/json">'+safeData(payload)+close+'<script id="card-runtime">'+runtime+close+'<script>'+startup+close+'</body></html>';
}
function prepareExport(link){const blob=new Blob([exportDocument()],{type:"text/html;charset=utf-8"});const url=URL.createObjectURL(blob);link.href=url;link.download=fileName();setTimeout(()=>URL.revokeObjectURL(url),120000);}
async function saveExport(event){
 const link=event.currentTarget;
 if(!apiTicket){prepareExport(link);return;}
 event.preventDefault();
 if(link.dataset.saving==="1")return;
 link.dataset.saving="1";
 try{
  const response=await fetch("/api/export",{method:"POST",cache:"no-store",credentials:"same-origin",
   headers:{"Content-Type":"application/json","X-Kartochka-Studio":"1"},
   body:JSON.stringify({product_id:card.source.id,html:exportDocument()})});
  const result=await response.json();
  if(!response.ok||!/^\/download\/[A-Za-z0-9_-]+\.html$/.test(result.download||""))throw Error(result.error||"Eksport bajarilmadi.");
  const dialog=el("dialog","ce-dialog");
  dialog.appendChild(el("p","","HTML kartochka tayyor. Faylni kompyuteringizga yuklab oling."));
  const fileLink=downloadLink("Tayyor HTMLni yuklab olish ↓",result.download,fileName());
  dialog.append(fileLink,document.createTextNode("  "),button("Yopish",()=>dialog.close()));
  dialog.addEventListener("close",()=>dialog.remove());document.body.appendChild(dialog);dialog.showModal();
  fileLink.focus();
 }catch(error){
  const dialog=el("dialog","ce-dialog");
  dialog.appendChild(el("p","","Mahalliy serverga ulanib bo‘lmadi. Tayyor nusxani brauzerdan yuklab oling."));
  const fallback=el("a","ce-btn","HTML faylini yuklab olish");prepareExport(fallback);
  dialog.append(fallback,button("Yopish",()=>dialog.close()));
  dialog.addEventListener("close",()=>dialog.remove());document.body.appendChild(dialog);dialog.showModal();
 }finally{delete link.dataset.saving;}
}
window.CardStudio={useProductPhoto:useProductPhoto,cropDialog:cropDialog,mount:render,postersFromTicket:postersFromTicket,refreshMedia:refreshMedia,prepareExport:prepareExport,saveExport:saveExport,exportDocument:exportDocument,toast:status};
})();

