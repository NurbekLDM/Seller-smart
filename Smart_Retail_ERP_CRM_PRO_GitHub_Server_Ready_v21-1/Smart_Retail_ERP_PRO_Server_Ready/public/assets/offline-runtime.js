/* Safe fallbacks for CDN outages: legacy tables, Bootstrap dialogs and chart rendering. */
(function installOfflineRuntime() {
  'use strict';

  if (typeof window.$ !== 'function') {
    const jquery = function minimalJquery(selector) {
      return {
        elements: typeof selector === 'string' ? Array.from(document.querySelectorAll(selector)) : [selector],
        DataTable() {
          return {
            destroy() {},
            draw() { return this; },
            clear() { return this; },
            rows() { return { data: () => [], count: () => 0 }; }
          };
        }
      };
    };
    jquery.fn = { dataTable: { isDataTable: () => false } };
    window.$ = jquery;
    window.jQuery = jquery;
  }

  if (window.$?.fn && typeof window.$.fn.DataTable !== 'function') {
    window.$.fn.DataTable = function missingDataTable() {
      return { destroy() {}, draw() { return this; }, clear() { return this; }, rows() { return { data: () => [], count: () => 0 }; } };
    };
    if (!window.$.fn.dataTable) window.$.fn.dataTable = { isDataTable: () => false };
  }

  if (!window.bootstrap?.Modal) {
    const instances = new WeakMap();

    class OfflineModal {
      constructor(element) {
        if (!element) throw new Error('Modal element was not found.');
        this.element = element;
        instances.set(element, this);
      }

      show() {
        this.element.style.display = 'block';
        this.element.removeAttribute('aria-hidden');
        this.element.setAttribute('aria-modal', 'true');
        this.element.classList.add('show');
        document.body.classList.add('modal-open');
        this.element.dispatchEvent(new Event('shown.bs.modal'));
      }

      hide() {
        this.element.classList.remove('show');
        this.element.style.display = 'none';
        this.element.setAttribute('aria-hidden', 'true');
        this.element.removeAttribute('aria-modal');
        if (!document.querySelector('.modal.show')) document.body.classList.remove('modal-open');
        this.element.dispatchEvent(new Event('hidden.bs.modal'));
      }

      toggle() { this.element.classList.contains('show') ? this.hide() : this.show(); }
      dispose() { this.hide(); instances.delete(this.element); }
      static getInstance(element) { return element ? instances.get(element) || null : null; }
      static getOrCreateInstance(element) { return OfflineModal.getInstance(element) || new OfflineModal(element); }
    }

    window.bootstrap = { ...(window.bootstrap || {}), Modal: OfflineModal };

    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-bs-toggle="modal"]');
      if (trigger) {
        const selector = trigger.getAttribute('data-bs-target');
        const target = selector ? document.querySelector(selector) : null;
        if (target) OfflineModal.getOrCreateInstance(target).show();
      }
      const dismiss = event.target.closest('[data-bs-dismiss="modal"]');
      if (dismiss) {
        const modal = dismiss.closest('.modal');
        if (modal) OfflineModal.getOrCreateInstance(modal).hide();
      }
      if (event.target.classList?.contains('modal') && event.target.classList.contains('show')) {
        OfflineModal.getOrCreateInstance(event.target).hide();
      }
    });

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const open = Array.from(document.querySelectorAll('.modal.show')).pop();
      if (open) OfflineModal.getOrCreateInstance(open).hide();
    });

    const fallbackStyle = document.createElement('style');
    fallbackStyle.id = 'smartRetailOfflineBootstrap';
    fallbackStyle.textContent = `
      .row{display:flex;flex-wrap:wrap;margin-right:-8px;margin-left:-8px}.row>*{padding-right:8px;padding-left:8px}.g-2{row-gap:8px}.g-3{row-gap:14px}.col-12,.col-md-12{width:100%}.col-6,.col-md-6{width:50%}.col-4,.col-md-4{width:33.333%}.col-3,.col-md-3{width:25%}.col-md-8{width:66.666%}.col-lg-7{width:58.333%}.col-lg-5{width:41.666%}.col-xl-3{width:25%}.h-100{height:100%}.w-100{width:100%}.d-flex{display:flex}.d-grid{display:grid}.d-none{display:none}.flex-wrap{flex-wrap:wrap}.justify-content-between{justify-content:space-between}.align-items-center{align-items:center}.align-items-start{align-items:flex-start}.text-center{text-align:center}.text-start{text-align:left}.text-end{text-align:right}.fw-bold{font-weight:700}.text-muted{color:var(--text-dim)!important}.text-danger{color:var(--danger)!important}.text-success{color:var(--ok)!important}.text-warning{color:var(--warn)!important}.gap-1{gap:4px}.gap-2{gap:8px}.gap-3{gap:13px}.m-0{margin:0}.mb-0{margin-bottom:0}.mb-1{margin-bottom:4px}.mb-2{margin-bottom:8px}.mb-3{margin-bottom:14px}.mt-1{margin-top:4px}.mt-2{margin-top:8px}.mt-3{margin-top:14px}.me-1{margin-right:4px}.p-0{padding:0}.p-4{padding:20px}.py-2{padding-top:8px;padding-bottom:8px}.py-4{padding-top:18px;padding-bottom:18px}.form-label{display:block;margin-bottom:5px;font-size:11px;color:var(--text-dim)}.form-control,.form-select{display:block;width:100%;min-height:36px;padding:7px 10px;outline:none;font:inherit}.form-control-sm,.form-select-sm{min-height:31px;font-size:12px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:8px 11px;border-radius:9px;text-decoration:none;font:inherit;cursor:pointer}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:9px 8px;text-align:left;border-bottom:1px solid var(--border)}.table-responsive{overflow:auto}.modal{position:fixed;inset:0;z-index:2100;display:none;overflow:auto;background:rgba(5,9,20,.72)}.modal.show{display:block}.modal-dialog{width:min(540px,calc(100% - 28px));margin:8vh auto}.modal-lg{width:min(860px,calc(100% - 28px))}.modal-content{overflow:hidden}.modal-header,.modal-footer{display:flex;justify-content:space-between;align-items:center;gap:9px;padding:14px 16px}.modal-header{border-bottom:1px solid var(--border)}.modal-footer{border-top:1px solid var(--border);justify-content:flex-end}.modal-body{padding:16px}.modal-title{margin:0}.btn-close{width:30px;height:30px;border:0;border-radius:7px;background:var(--panel-strong);color:var(--text);cursor:pointer}.btn-close:after{content:'×';font-size:20px}.modal-open{overflow:hidden}.input-group{display:flex}.input-group>.form-control{flex:1}.form-check-input{width:15px;height:15px}.badge{display:inline-block;padding:4px 7px;border-radius:7px}hr{border:0;border-top:1px solid var(--border);margin:14px 0}@media(max-width:991px){.col-lg-7,.col-lg-5{width:100%}}@media(max-width:767px){.col-md-3,.col-md-4,.col-md-6,.col-md-8{width:100%}.col-6{width:50%}.col-xl-3{width:50%}.modal-dialog{margin:5vh auto}}
    `;
    document.head.appendChild(fallbackStyle);
  }

  if (typeof window.Chart !== 'function') {
    class OfflineChart {
      constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.options = options;
        this.render();
      }

      render() {
        const context = this.canvas?.getContext?.('2d');
        if (!context) return;
        const bounds = this.canvas.getBoundingClientRect();
        const width = Math.max(220, Math.round(bounds.width || this.canvas.width || 420));
        const height = Math.max(125, Math.round(bounds.height || Number(this.canvas.getAttribute('height')) || 180));
        const scale = Math.min(2, window.devicePixelRatio || 1);
        this.canvas.width = width * scale;
        this.canvas.height = height * scale;
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, width, height);
        const sets = this.options.data?.datasets || [];
        if (!sets.length) return;
        const padding = { top: 15, right: 12, bottom: 23, left: 14 };
        const values = sets.flatMap(set => (set.data || []).map(value => Math.max(0, Number(value) || 0)));
        const maximum = Math.max(1, ...values);
        const usableWidth = width - padding.left - padding.right;
        const usableHeight = height - padding.top - padding.bottom;
        if (['doughnut', 'pie'].includes(this.options.type)) {
          const entries = sets[0].data || [];
          const sum = entries.reduce((total, value) => total + Math.max(0, Number(value) || 0), 0) || 1;
          let angle = -Math.PI / 2;
          entries.forEach((value, index) => {
            const next = angle + Math.PI * 2 * (Math.max(0, Number(value) || 0) / sum);
            context.beginPath();
            context.moveTo(width / 2, height / 2);
            context.arc(width / 2, height / 2, Math.min(width, height) * .36, angle, next);
            context.closePath();
            const background = sets[0].backgroundColor;
            context.fillStyle = Array.isArray(background) ? background[index] || '#6c6bff' : background || '#6c6bff';
            context.fill();
            angle = next;
          });
          if (this.options.type === 'doughnut') {
            context.globalCompositeOperation = 'destination-out';
            context.beginPath(); context.arc(width / 2, height / 2, Math.min(width, height) * .18, 0, Math.PI * 2); context.fill();
            context.globalCompositeOperation = 'source-over';
          }
          return;
        }
        context.strokeStyle = 'rgba(130,145,170,.18)';
        context.beginPath(); context.moveTo(padding.left, height - padding.bottom); context.lineTo(width - padding.right, height - padding.bottom); context.stroke();
        sets.forEach((set, setIndex) => {
          const points = set.data || [];
          const color = Array.isArray(set.borderColor) ? set.borderColor[0] : set.borderColor || set.backgroundColor || ['#6c6bff', '#22c77a', '#f5a623'][setIndex % 3];
          if (this.options.type === 'bar') {
            const segment = usableWidth / Math.max(1, points.length);
            const barWidth = Math.max(3, segment / Math.max(1, sets.length) * .72);
            context.fillStyle = Array.isArray(color) ? color[0] : color;
            points.forEach((value, index) => {
              const h = usableHeight * Math.max(0, Number(value) || 0) / maximum;
              context.fillRect(padding.left + index * segment + setIndex * barWidth, height - padding.bottom - h, barWidth, h);
            });
          } else {
            context.strokeStyle = Array.isArray(color) ? color[0] : color;
            context.lineWidth = 2;
            context.beginPath();
            points.forEach((value, index) => {
              const x = padding.left + usableWidth * index / Math.max(1, points.length - 1);
              const y = height - padding.bottom - usableHeight * Math.max(0, Number(value) || 0) / maximum;
              if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
            });
            context.stroke();
          }
        });
      }

      update() { this.render(); }
      destroy() {
        const context = this.canvas?.getContext?.('2d');
        if (context) context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    window.Chart = OfflineChart;
  }
})();
