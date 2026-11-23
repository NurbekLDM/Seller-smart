async function grant(action){
 if(!['settings.backup','settings.restore'].includes(action))throw Error('Ruxsat turi noto‘g‘ri.');
 const session=()=>JSON.stringify(root.mergedReadAuthSession?.()||null);
 const credentials=()=>read('uzum-analytics-merged-credentials-v3');
 const current=()=>root.mergedCurrentAccess?.();
 if(current()?.role!=='admin')throw Error('Analitika administratori sifatida kiring.');
 const identity=session(),credential=credentials();
 const password=root.prompt(action==='settings.backup'?'Zaxira olish uchun analitika administrator parolini kiriting.':'Tiklash uchun analitika administrator parolini kiriting.');
 if(password===null)return null;
 if(!await root.mergedAdminCredentialsMatch(current()?.username,password))throw Error('Administrator paroli noto‘g‘ri.');
 if(identity!==session()||credential!==credentials()||current()?.role!=='admin')throw Error('Kirish ma’lumoti o‘zgardi. Qayta urinib ko‘ring.');
 const expires=Date.now()+5*60*1000,token=Object.freeze({});
 const service={check(_,requested){if(requested!==action||Date.now()>expires||identity!==session()||credential!==credentials()||current()?.role!=='admin')throw Error('Administrator tasdig‘i eskirgan. Qayta tasdiqlang.');}};
 grants.set(token,{service,token,action});return token;
}
