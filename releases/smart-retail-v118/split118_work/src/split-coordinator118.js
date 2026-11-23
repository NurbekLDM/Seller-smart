/* Two standalone documents; existing native storage and A13 formats remain intact. */
(function(root){'use strict';
  const mode='__MODE__',ERP='smart-retail-business-writer-v101',ANALYTICS='smart-retail-analytics-writer-v118';
  const writerName=mode==='erp'?ERP:ANALYTICS;
  async function acquireOther(){
    if(!root.navigator?.locks?.request)throw Error('Bu brauzer xavfsiz yozishni qo‘llamaydi. Yangilangan Chrome yoki Edge’dan foydalaning.');
    const other=mode==='erp'?ANALYTICS:ERP;
    return new Promise((resolve,reject)=>{
      root.navigator.locks.request(other,{ifAvailable:true},async lock=>{
        if(!lock){reject(Error('Zaxira yoki tiklash uchun shu manzildagi '+(mode==='erp'?'Analitika':'ERP')+' oynasini yoping va qayta urinib ko‘ring.'));return;}
        let release;const held=new Promise(ok=>release=ok);let done=false;
        resolve(()=>{if(!done){done=true;release();}});await held;
      }).catch(reject);
    });
  }
  async function exclusive(fn){const release=await acquireOther();try{return await fn();}finally{release();}}
  root.SRSplit118=Object.freeze({version:118,mode,writerName,acquireOther,exclusive});
})(window);
