/* Smart Retail ERP 21.0: receivables ledger, customer profiles and collections. */
(function smartRetailProfessionalCrm() {
  'use strict';

  const VERSION = '21.0.0';
  const DAY = 86_400_000;
  const PAYMENT_KEY = 'srerp_debt_payments_v21';
  const NOTES_KEY = 'srerp_customer_notes_v21';
  const SETTINGS_KEY = 'srerp_receivables_settings_v21';
  const DEFAULT_SETTINGS = { defaultCreditDays: 30, blockOverLimit: true };
  const filters = { query: '', status: '', customerId: '', from: '', to: '', sort: 'due_asc' };
  let selectedCustomerId = '';
  let selectedProfileTab = 'overview';
  let installed = false;

  DB_KEYS.debtPayments = PAYMENT_KEY;
  DB_KEYS.customerNotes = NOTES_KEY;
  DB_KEYS.receivablesSettings = SETTINGS_KEY;

  const byId = id => document.getElementById(id);
  const amount = value => {
    const numeric = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric * 100) / 100) : 0;
  };
  const text = value => String(value ?? '').trim();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const today = () => new Date().toISOString().slice(0, 10);
  const time = () => new Date().toISOString();
  const displayMoney = value => `${fmt(amount(value))} so‘m`;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : '';
  const addDays = (value, count) => {
    const date = new Date(`${validDate(value) || today()}T12:00:00`);
    date.setDate(date.getDate() + Number(count || 0));
    return date.toISOString().slice(0, 10);
  };
  const daysBetween = (start, finish) => Math.floor((new Date(`${finish}T12:00:00`) - new Date(`${start}T12:00:00`)) / DAY);
  const phoneDigits = value => text(value).replace(/\D/g, '');
  const activeActor = () => typeof authCurrentUser !== 'undefined' && authCurrentUser
    ? authCurrentUser.fullName || authCurrentUser.username || 'Administrator'
    : typeof activeEmployeeName !== 'undefined' ? activeEmployeeName : 'Tizim';
  const isAdmin = () => typeof authCurrentUser !== 'undefined' && authCurrentUser?.role === 'ADMIN';
  const mayWrite = () => typeof authRequireRole !== 'function' || authRequireRole(['ADMIN', 'POS']);
  const notify = (message, bad = false) => typeof showToast === 'function'
    ? showToast(message, bad ? 'bi-x-circle text-danger' : 'bi-check-circle text-success')
    : console[bad ? 'error' : 'info'](message);
  const log = message => { if (typeof doLog === 'function') doLog(message); };
  const payments = () => db_get(PAYMENT_KEY);
  const customerNotes = () => db_get(NOTES_KEY);
  const customers = () => db_get(DB_KEYS.customers);
  const debts = () => db_get(DB_KEYS.debts);
  const settings = () => {
    try {
      const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return { ...DEFAULT_SETTINGS, ...value, defaultCreditDays: Math.max(1, Math.min(365, Number(value.defaultCreditDays) || 30)) };
    } catch (_) { return { ...DEFAULT_SETTINGS }; }
  };
  const openBalance = customerId => debts()
    .filter(debt => debt.customerId === customerId && debt.status !== 'Bekor qilingan')
    .reduce((sum, debt) => sum + amount(debt.remaining), 0);

  function stateFor(debt, customer) {
    const remaining = amount(debt.remaining);
    if (debt.status === 'Bekor qilingan' || debt.cancelledAt) return { key: 'cancelled', label: 'Bekor qilingan', kind: 'danger', days: 0 };
    if (!remaining) return { key: 'paid', label: 'Yopilgan', kind: 'ok', days: 0 };
    const dueDate = validDate(debt.dueDate);
    const difference = dueDate ? daysBetween(today(), dueDate) : null;
    if (difference !== null && difference < 0) return { key: 'overdue', label: `${Math.abs(difference)} kun kechikkan`, kind: 'danger', days: difference };
    const limit = amount(customer?.limit);
    if ((limit && openBalance(debt.customerId) > limit) || debt.status === 'Muammo') return { key: 'overlimit', label: 'Limitdan oshgan', kind: 'danger', days: difference };
    if (difference === 0) return { key: 'today', label: 'Bugun to‘lanadi', kind: 'warn', days: difference };
    if (difference !== null && difference <= 7) return { key: 'upcoming', label: `${difference} kun qoldi`, kind: 'warn', days: difference };
    return { key: 'open', label: 'Nazoratda', kind: 'accent', days: difference };
  }

  function normalize() {
    let changed = false;
    const list = debts();
    const customerById = new Map(customers().map(customer => [customer.id, customer]));
    list.forEach((debt, index) => {
      const customer = customerById.get(debt.customerId);
      const total = amount(debt.total);
      const paid = Math.min(total, amount(debt.paid));
      const remaining = debt.status === 'Bekor qilingan' ? 0 : Math.max(0, total - paid);
      const defaults = {
        invoiceNo: `INV-${String(debt.date || today()).replace(/-/g, '')}-${String(index + 1).padStart(4, '0')}`,
        dueDate: addDays(debt.date || today(), amount(customer?.creditDays) || settings().defaultCreditDays),
        createdAt: debt.createdAt || `${validDate(debt.date) || today()}T12:00:00.000Z`,
        currency: 'UZS'
      };
      for (const [key, value] of Object.entries(defaults)) {
        if (!debt[key]) { debt[key] = value; changed = true; }
      }
      if (debt.total !== total || debt.paid !== paid || debt.remaining !== remaining) {
        Object.assign(debt, { total, paid, remaining });
        changed = true;
      }
      if (customer && debt.customer !== customer.name) { debt.customer = customer.name; changed = true; }
    });
    if (changed) db_set(DB_KEYS.debts, list);
    if (!localStorage.getItem(PAYMENT_KEY)) db_set(PAYMENT_KEY, []);
    if (!localStorage.getItem(NOTES_KEY)) db_set(NOTES_KEY, []);
  }

  function badge(state) {
    return `<span class="crm21-badge ${escape(state.kind)}">${escape(state.label)}</span>`;
  }

  function modalMarkup() {
    return `
      <div class="modal fade" id="crm21PaymentModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content">
        <div class="modal-header"><h6 class="modal-title fw-bold"><i class="bi bi-wallet2 me-1"></i>Qarz to‘lovini qabul qilish</h6><button class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
        <div class="modal-body"><input type="hidden" id="crm21PaymentDebtId"><div class="crm21-payment-total"><span id="crm21PaymentCustomer">Mijoz</span><strong id="crm21PaymentBalance">0 so‘m</strong><small class="text-muted">Qolgan qarzdorlik</small></div>
          <div class="row g-2"><div class="col-6"><label class="form-label">Summa *</label><input id="crm21PaymentAmount" class="form-control" type="number" min="1" step="1" inputmode="numeric"></div>
          <div class="col-6"><label class="form-label">Sana *</label><input id="crm21PaymentDate" class="form-control" type="date"></div>
          <div class="col-6"><label class="form-label">To‘lov turi</label><select id="crm21PaymentMethod" class="form-select"><option>Naqd</option><option>Karta</option><option>Bank o‘tkazmasi</option><option>Click</option><option>Payme</option><option>Uzum Bank</option></select></div>
          <div class="col-6"><label class="form-label">Chek / hujjat raqami</label><input id="crm21PaymentReference" class="form-control" maxlength="80"></div>
          <div class="col-12"><label class="form-label">Izoh</label><input id="crm21PaymentNote" class="form-control" maxlength="250" placeholder="Ixtiyoriy izoh"></div></div></div>
        <div class="modal-footer"><button class="btn btn-outline-erp" data-bs-dismiss="modal">Bekor qilish</button><button class="btn btn-accent" onclick="crm21SavePayment()"><i class="bi bi-check-lg"></i> To‘lovni saqlash</button></div>
      </div></div></div>
      <div class="modal fade" id="crm21ProfileModal" tabindex="-1"><div class="modal-dialog crm21-modal-wide modal-dialog-scrollable"><div class="modal-content">
        <div class="modal-header"><h6 class="modal-title fw-bold"><i class="bi bi-person-vcard me-1"></i>Mijoz kartochkasi</h6><button class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
        <div class="modal-body" id="crm21ProfileBody"></div>
      </div></div></div>
      <div class="modal fade" id="crm21DebtEditModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content">
        <div class="modal-header"><h6 class="modal-title fw-bold">Qarzdorlikni tahrirlash</h6><button class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
        <div class="modal-body"><input type="hidden" id="crm21EditDebtId"><div class="row g-2"><div class="col-6"><label class="form-label">Muddat *</label><input type="date" class="form-control" id="crm21EditDebtDue"></div><div class="col-6"><label class="form-label">Hujjat</label><input class="form-control" id="crm21EditDebtInvoice" maxlength="80"></div><div class="col-12"><label class="form-label">Izoh</label><textarea class="form-control" id="crm21EditDebtNote" rows="3" maxlength="500"></textarea></div></div></div>
        <div class="modal-footer"><button class="btn btn-outline-erp" data-bs-dismiss="modal">Bekor qilish</button><button class="btn btn-accent" onclick="crm21SaveDebtEdit()">Saqlash</button></div>
      </div></div></div>`;
  }

  function install() {
    if (installed || !byId('view-crm') || !byId('view-customers')) return;
    installed = true;
    normalize();
    document.title = 'Smart Retail ERP 21 — Professional CRM va qarzdorlik';
    const brand = document.querySelector('#sidebar .brand .sub');
    if (brand) brand.textContent = 'Enterprise ERP 21 · CRM PRO';
    const section = byId('view-crm');
    const originalDebtCard = byId('tblDebts')?.closest('.card-erp');
    if (originalDebtCard) originalDebtCard.style.display = 'none';
    const overview = section.firstElementChild;
    if (overview) overview.style.display = 'none';

    section.insertAdjacentHTML('afterbegin', `
      <div id="crm21Root"><div class="crm21-hero"><div><div class="crm21-eyebrow">Smart Retail · Debitorlik nazorati</div><h2 class="crm21-title">Qarzdorlik va to‘lovlar</h2><div class="crm21-subtitle">Mijoz kesimida qarz, muddat, to‘lov tarixi va qarz limitini bitta reestrdan boshqaring.</div></div>
        <div class="crm21-actions"><span class="crm21-sync" id="crm21SyncState" data-state="local"><span class="crm21-sync-dot"></span><span>Qurilmada saqlanmoqda</span></span><button class="btn btn-outline-erp btn-sm-erp" onclick="crm21ExportLedger()"><i class="bi bi-file-earmark-spreadsheet"></i> Eksport</button><button class="btn btn-accent btn-sm-erp" onclick="crm21OpenNewDebt()"><i class="bi bi-plus-lg"></i> Yangi qarz</button></div></div>
      <div class="crm21-summary" id="crm21Summary"></div>
      <div class="card-erp"><div class="d-flex justify-content-between align-items-start gap-2 flex-wrap"><div><div class="section-title mb-0">Qarzdorlik reestri</div><div class="section-desc mb-0">Qidiruv, status, mijoz va sana bo‘yicha filtrlash</div></div><button class="btn btn-outline-erp btn-sm-erp" onclick="crm21ResetFilters()"><i class="bi bi-arrow-counterclockwise"></i> Tozalash</button></div>
        <div class="crm21-filter-grid"><input class="form-control" id="crm21Search" placeholder="Mijoz, telefon, hujjat yoki izoh..." oninput="crm21UpdateFilter('query',this.value)">
          <select class="form-select" id="crm21StatusFilter" onchange="crm21UpdateFilter('status',this.value)"><option value="">Barcha holatlar</option><option value="open">Ochiq qarzlar</option><option value="overdue">Muddati o‘tgan</option><option value="today">Bugungi to‘lovlar</option><option value="upcoming">7 kun ichida</option><option value="overlimit">Limitdan oshgan</option><option value="paid">Yopilgan</option><option value="cancelled">Bekor qilingan</option></select>
          <select class="form-select" id="crm21CustomerFilter" onchange="crm21UpdateFilter('customerId',this.value)"><option value="">Barcha mijozlar</option></select>
          <input class="form-control" id="crm21DateFrom" type="date" onchange="crm21UpdateFilter('from',this.value)" title="Boshlanish sanasi"><input class="form-control" id="crm21DateTo" type="date" onchange="crm21UpdateFilter('to',this.value)" title="Tugash sanasi"></div>
        <div class="crm21-table-shell"><table class="table table-sm crm21-table"><thead><tr><th>Hujjat</th><th>Mijoz</th><th>Qarz sanasi</th><th>Muddat</th><th>Jami</th><th>To‘langan</th><th>Qoldiq</th><th>Limit / band</th><th>Holat</th><th>Amallar</th></tr></thead><tbody id="crm21DebtRows"></tbody></table></div>
        <div class="crm21-foot"><span id="crm21TableCount">0 ta yozuv</span><strong id="crm21FilteredBalance">0 so‘m</strong></div>
        <div class="crm21-aging" id="crm21Aging"></div></div></div>`);

    document.body.insertAdjacentHTML('beforeend', modalMarkup());
    installDebtFields();
    installCustomerFields();
    installCustomerTools();
    installFinancePanel();
    refreshAll();
  }

  function installDebtFields() {
    const wrapper = byId('dbtPaid')?.closest('.row');
    if (wrapper && !byId('crm21DebtDueDate')) {
      wrapper.insertAdjacentHTML('beforeend', '<div class="col-6"><label class="form-label">To‘lov muddati *</label><input type="date" class="form-control" id="crm21DebtDueDate"></div><div class="col-6"><label class="form-label">Hujjat raqami</label><input class="form-control" id="crm21DebtInvoice" maxlength="80" placeholder="Avtomatik"></div><div class="col-12"><label class="form-label">Qarz izohi</label><input class="form-control" id="crm21DebtNote" maxlength="500" placeholder="Qarzning sababi yoki kelishuv"></div>');
    }
    const pos = byId('v7PosDebtNote')?.closest('.row');
    if (pos && !byId('crm21PosDueDate')) {
      pos.insertAdjacentHTML('beforeend', '<div class="col-6"><label class="form-label">Qaytarish muddati</label><input type="date" class="form-control form-control-sm" id="crm21PosDueDate"></div><div class="col-6"><label class="form-label">Bo‘sh kredit limiti</label><input class="form-control form-control-sm" id="crm21PosAvailable" readonly></div>');
      byId('posCustomerSelect')?.addEventListener('change', refreshPosLimit);
      byId('paymentType')?.addEventListener('change', refreshPosLimit);
      byId('v7PosDebtAmount')?.addEventListener('input', refreshPosLimit);
    }
    byId('dbtCustomer')?.addEventListener('change', resetDebtDueDate);
    resetDebtDueDate();
  }

  function installCustomerFields() {
    const noteColumn = byId('v11CustomerNote')?.closest('.col-12');
    if (noteColumn && !byId('crm21CustomerSegment')) {
      noteColumn.insertAdjacentHTML('beforebegin', '<div class="col-md-4"><label class="form-label">Mijoz segmenti</label><select class="form-select" id="crm21CustomerSegment"><option>Yangi</option><option>Doimiy</option><option>VIP</option><option>Ulgurji</option><option>Hamkor</option></select></div><div class="col-md-4"><label class="form-label">Telegram</label><input class="form-control" id="crm21CustomerTelegram" placeholder="@username" maxlength="80"></div><div class="col-md-4"><label class="form-label">Qarz muddati, kun</label><input type="number" min="1" max="365" class="form-control" id="crm21CustomerCreditDays" value="30"></div><div class="col-md-6"><label class="form-label">Email</label><input type="email" class="form-control" id="crm21CustomerEmail" maxlength="160"></div><div class="col-md-6"><label class="form-label">Tug‘ilgan sana</label><input type="date" class="form-control" id="crm21CustomerBirthday"></div>');
    }
  }

  function installCustomerTools() {
    const toolbar = document.querySelector('#view-customers .v11-customer-toolbar > .d-flex');
    if (toolbar && !byId('crm21CustomerImport')) {
      toolbar.insertAdjacentHTML('afterbegin', '<button class="btn btn-outline-erp" onclick="document.getElementById(\'crm21CustomerImport\').click()"><i class="bi bi-upload"></i> Import</button><input type="file" id="crm21CustomerImport" accept=".xlsx,.xls,.csv" hidden>');
      byId('crm21CustomerImport').addEventListener('change', importCustomers);
    }
    const card = byId('v11CustomerRows')?.closest('.card-erp');
    if (card && !byId('crm21CustomerSegmentFilter')) {
      const target = card.querySelector('.v11-customer-toolbar');
      target?.insertAdjacentHTML('afterend', '<div class="crm21-customer-extra mb-3"><select class="form-select" id="crm21CustomerSegmentFilter" onchange="v11RenderCustomers()"><option value="">Barcha segmentlar</option><option>Yangi</option><option>Doimiy</option><option>VIP</option><option>Ulgurji</option><option>Hamkor</option></select><select class="form-select" id="crm21CustomerStateFilter" onchange="v11RenderCustomers()"><option value="">Barcha mijozlar</option><option value="active">Faqat faol</option><option value="inactive">Nofaol</option><option value="debt">Qarzdor</option><option value="overdue">Muddati o‘tgan</option></select><select class="form-select" id="crm21CustomerSort" onchange="v11RenderCustomers()"><option value="name">Ism bo‘yicha</option><option value="debt_desc">Katta qarzdan</option><option value="recent">Yangi mijozlar</option></select></div>');
      const headings = card.querySelector('thead tr');
      if (headings) headings.innerHTML = '<th>Kod</th><th>Mijoz / segment</th><th>Aloqa</th><th>Manzil</th><th>Limit</th><th>Joriy qarz</th><th data-v13-bonus-head>Bonus</th><th>Bo‘sh limit</th><th>Holat</th><th>Oxirgi faollik</th><th class="text-end">Amallar</th>';
    }
  }

  function installFinancePanel() {
    const section = byId('view-finance');
    if (!section || byId('crm21FinancePanel')) return;
    section.insertAdjacentHTML('afterbegin', '<div class="crm21-finance-strip" id="crm21FinancePanel"><div class="crm21-finance-item"><span>Bugun qarzdan undirilgan</span><b id="crm21FinanceToday">0 so‘m</b></div><div class="crm21-finance-item"><span>Shu oy qarzdan undirilgan</span><b id="crm21FinanceMonth">0 so‘m</b></div><div class="crm21-finance-item"><span>Kutilayotgan debitorlik</span><b id="crm21FinanceOutstanding">0 so‘m</b></div></div>');
  }

  function resetDebtDueDate() {
    const customer = customers().find(row => row.id === byId('dbtCustomer')?.value);
    if (byId('crm21DebtDueDate')) byId('crm21DebtDueDate').value = addDays(today(), amount(customer?.creditDays) || settings().defaultCreditDays);
  }

  function refreshPosLimit() {
    const customer = customers().find(row => row.id === byId('posCustomerSelect')?.value);
    if (!customer) return;
    if (byId('crm21PosDueDate') && !byId('crm21PosDueDate').value) byId('crm21PosDueDate').value = addDays(today(), amount(customer.creditDays) || settings().defaultCreditDays);
    if (byId('crm21PosAvailable')) byId('crm21PosAvailable').value = displayMoney(Math.max(0, amount(customer.limit) - openBalance(customer.id)));
  }

  function matches(debt, customer, state) {
    const search = filters.query.toLocaleLowerCase('uz');
    if (search && ![debt.invoiceNo, debt.customer, debt.note, customer?.phone, customer?.phone2, customer?.code]
      .some(value => text(value).toLocaleLowerCase('uz').includes(search))) return false;
    if (filters.customerId && debt.customerId !== filters.customerId) return false;
    if (filters.from && debt.date < filters.from) return false;
    if (filters.to && debt.date > filters.to) return false;
    if (!filters.status) return true;
    if (filters.status === 'open') return !['paid', 'cancelled'].includes(state.key);
    return state.key === filters.status;
  }

  function buildRows() {
    const map = new Map(customers().map(customer => [customer.id, customer]));
    return debts()
      .map(debt => ({ debt, customer: map.get(debt.customerId), state: stateFor(debt, map.get(debt.customerId)) }))
      .filter(({ debt, customer, state }) => matches(debt, customer, state))
      .sort((left, right) => {
        if (filters.sort === 'balance_desc') return amount(right.debt.remaining) - amount(left.debt.remaining);
        return String(left.debt.dueDate || '9999').localeCompare(String(right.debt.dueDate || '9999'))
          || String(right.debt.createdAt || '').localeCompare(String(left.debt.createdAt || ''));
      });
  }

  function renderSummary() {
    const all = debts().filter(debt => debt.status !== 'Bekor qilingan');
    const map = new Map(customers().map(customer => [customer.id, customer]));
    const open = all.filter(debt => amount(debt.remaining));
    const overdue = open.filter(debt => stateFor(debt, map.get(debt.customerId)).key === 'overdue');
    const dueToday = open.filter(debt => validDate(debt.dueDate) === today());
    const collectedMonth = payments().filter(payment => !payment.reversedAt && String(payment.date).slice(0, 7) === today().slice(0, 7));
    const total = open.reduce((sum, debt) => sum + amount(debt.remaining), 0);
    const cards = [
      { label: 'Ochiq qarzdorlik', value: displayMoney(total), note: `${open.length} ta ochiq hujjat`, kind: '' },
      { label: 'Muddati o‘tgan', value: displayMoney(overdue.reduce((sum, debt) => sum + amount(debt.remaining), 0)), note: `${overdue.length} ta kechikkan qarz`, kind: 'is-danger' },
      { label: 'Bugun kutilmoqda', value: displayMoney(dueToday.reduce((sum, debt) => sum + amount(debt.remaining), 0)), note: `${dueToday.length} ta bugungi to‘lov`, kind: 'is-warn' },
      { label: 'Shu oy undirildi', value: displayMoney(collectedMonth.reduce((sum, payment) => sum + amount(payment.amount), 0)), note: `${collectedMonth.length} ta tasdiqlangan to‘lov`, kind: 'is-ok' }
    ];
    if (byId('crm21Summary')) byId('crm21Summary').innerHTML = cards.map(card => `<div class="crm21-stat ${card.kind}"><div class="crm21-stat-label">${escape(card.label)}</div><div class="crm21-stat-value">${escape(card.value)}</div><div class="crm21-stat-note">${escape(card.note)}</div></div>`).join('');
    if (byId('crmCustCount')) byId('crmCustCount').textContent = customers().length;
    if (byId('crmDebtTotal')) byId('crmDebtTotal').textContent = displayMoney(total);
    if (byId('crmWarnCount')) byId('crmWarnCount').textContent = open.length - overdue.length;
    if (byId('crmDangerCount')) byId('crmDangerCount').textContent = overdue.length;
  }

  function renderCustomerFilter() {
    const control = byId('crm21CustomerFilter');
    if (!control) return;
    const value = filters.customerId;
    control.innerHTML = '<option value="">Barcha mijozlar</option>' + customers()
      .slice().sort((left, right) => text(left.name).localeCompare(text(right.name)))
      .map(customer => `<option value="${escape(customer.id)}">${escape(customer.name)}</option>`).join('');
    control.value = value;
  }

  function renderDebtTable() {
    const body = byId('crm21DebtRows');
    if (!body) return;
    const rows = buildRows();
    body.innerHTML = rows.map(({ debt, customer, state }) => {
      const balance = amount(debt.remaining);
      const total = amount(debt.total);
      const percentage = total ? Math.min(100, Math.round(amount(debt.paid) / total * 100)) : 100;
      const exposure = openBalance(debt.customerId);
      const customerName = text(customer?.name || debt.customer || 'Noma’lum mijoz');
      const dueClass = state.key === 'overdue' ? 'crm21-overdue' : '';
      return `<tr><td><span class="crm21-mono">${escape(debt.invoiceNo || debt.id)}</span><div class="crm21-meta">${escape(debt.saleOrderId || 'Qo‘lda kiritilgan')}</div></td>
        <td class="crm21-customer-cell"><button type="button" class="btn p-0 text-start" onclick="crm21OpenProfile('${escape(debt.customerId)}')"><span class="crm21-customer-name">${escape(customerName)}</span></button><div class="crm21-meta">${escape(customer?.phone || 'Telefon ko‘rsatilmagan')}</div></td>
        <td class="crm21-mono">${escape(debt.date || '—')}</td><td class="crm21-mono ${dueClass}">${escape(debt.dueDate || '—')}</td><td class="crm21-mono">${escape(displayMoney(total))}</td>
        <td class="crm21-mono">${escape(displayMoney(debt.paid))}<div class="crm21-progress"><span style="width:${percentage}%"></span></div></td><td class="crm21-mono"><strong>${escape(displayMoney(balance))}</strong></td>
        <td class="crm21-mono">${escape(displayMoney(customer?.limit || 0))}<div class="crm21-meta">Band: ${escape(displayMoney(exposure))}</div></td><td>${badge(state)}</td>
        <td><div class="crm21-row-actions">${balance && state.key !== 'cancelled' ? `<button class="crm21-icon-btn pay" onclick="crm21OpenPayment('${escape(debt.id)}')" title="To‘lov qabul qilish"><i class="bi bi-cash-coin"></i></button><button class="crm21-icon-btn" onclick="crm21Remind('${escape(debt.id)}')" title="Eslatma nusxalash"><i class="bi bi-bell"></i></button>` : ''}<button class="crm21-icon-btn" onclick="crm21OpenDebtEdit('${escape(debt.id)}')" title="Muddat va izohni tahrirlash"><i class="bi bi-pencil"></i></button><button class="crm21-icon-btn" onclick="crm21OpenProfile('${escape(debt.customerId)}')" title="Mijoz kartasi"><i class="bi bi-person-vcard"></i></button></div></td></tr>`;
    }).join('') || '<tr><td colspan="10"><div class="crm21-empty"><i class="bi bi-inboxes"></i>Tanlangan shartlar bo‘yicha qarzdorlik topilmadi.</div></td></tr>';
    byId('crm21TableCount').textContent = `${rows.length} ta yozuv · ${new Set(rows.map(row => row.debt.customerId)).size} ta mijoz`;
    byId('crm21FilteredBalance').textContent = `Qoldiq: ${displayMoney(rows.reduce((sum, row) => sum + amount(row.debt.remaining), 0))}`;
    renderAging();
  }

  function renderAging() {
    const root = byId('crm21Aging');
    if (!root) return;
    const buckets = [
      { title: 'Muddatida', from: -Infinity, to: 0 },
      { title: '1–7 kun', from: 1, to: 7 },
      { title: '8–30 kun', from: 8, to: 30 },
      { title: '31–60 kun', from: 31, to: 60 },
      { title: '60+ kun', from: 61, to: Infinity }
    ];
    root.innerHTML = buckets.map(bucket => {
      const list = debts().filter(debt => {
        if (!amount(debt.remaining) || !validDate(debt.dueDate) || debt.status === 'Bekor qilingan') return false;
        const overdueDays = daysBetween(debt.dueDate, today());
        return overdueDays >= bucket.from && overdueDays <= bucket.to;
      });
      return `<div class="crm21-age"><small>${escape(bucket.title)} · ${list.length} ta</small><strong>${escape(displayMoney(list.reduce((sum, debt) => sum + amount(debt.remaining), 0)))}</strong></div>`;
    }).join('');
  }

  function renderFinancePanel() {
    const valid = payments().filter(payment => !payment.reversedAt);
    if (byId('crm21FinanceToday')) byId('crm21FinanceToday').textContent = displayMoney(valid.filter(payment => payment.date === today()).reduce((sum, payment) => sum + amount(payment.amount), 0));
    if (byId('crm21FinanceMonth')) byId('crm21FinanceMonth').textContent = displayMoney(valid.filter(payment => String(payment.date).slice(0, 7) === today().slice(0, 7)).reduce((sum, payment) => sum + amount(payment.amount), 0));
    if (byId('crm21FinanceOutstanding')) byId('crm21FinanceOutstanding').textContent = displayMoney(debts().filter(debt => debt.status !== 'Bekor qilingan').reduce((sum, debt) => sum + amount(debt.remaining), 0));
  }

  function refreshAll() {
    if (!installed) return;
    renderSummary();
    renderCustomerFilter();
    renderDebtTable();
    renderFinancePanel();
    renderCustomerTable();
    refreshPosLimit();
    if (selectedCustomerId && byId('crm21ProfileModal')?.classList.contains('show')) renderProfile();
  }

  function ensureCredit(customer, requested) {
    if (!customer) { notify('Avval mijozni tanlang.', true); return false; }
    if (customer.active === false) { notify('Nofaol mijozga qarz rasmiylashtirib bo‘lmaydi.', true); return false; }
    const existing = openBalance(customer.id);
    const limit = amount(customer.limit);
    if (existing + amount(requested) <= limit && limit > 0) return true;
    const message = `${customer.name} uchun kredit limiti ${displayMoney(limit)}. Mavjud qarz ${displayMoney(existing)}, yangi qarz ${displayMoney(requested)}.`;
    if (!isAdmin()) { notify(`${message} Administrator ruxsati kerak.`, true); return false; }
    if (!window.confirm(`${message}\n\nAdministrator sifatida limitdan oshirishga ruxsat berasizmi?`)) return false;
    log(`Kredit limiti administrator tomonidan oshirildi: ${customer.name}, mavjud ${fmt(existing)}, yangi ${fmt(requested)}`);
    return true;
  }

  function syncCreditSale(debt) {
    if (!DB_KEYS.creditSales) return;
    const rows = db_get(DB_KEYS.creditSales);
    const entry = rows.find(row => row.debtId === debt.id || row.orderId === debt.saleOrderId);
    if (!entry) return;
    Object.assign(entry, { remaining: amount(debt.remaining), status: debt.status, dueDate: debt.dueDate, updatedAt: time() });
    db_set(DB_KEYS.creditSales, rows);
  }

  function paymentStatus(debt, customer) {
    if (debt.status === 'Bekor qilingan') return 'Bekor qilingan';
    if (!amount(debt.remaining)) return 'Yopilgan';
    const projected = debts()
      .filter(row => row.customerId === debt.customerId && row.id !== debt.id && row.status !== 'Bekor qilingan')
      .reduce((sum, row) => sum + amount(row.remaining), 0) + amount(debt.remaining);
    return projected > amount(customer?.limit) ? 'Muammo' : 'Nazorat';
  }

  function addPaymentRecord(debt, data) {
    const row = {
      id: uid('PAY'), debtId: debt.id, customerId: debt.customerId, customer: debt.customer,
      amount: amount(data.amount), date: validDate(data.date) || today(), method: text(data.method || 'Naqd'),
      reference: text(data.reference).slice(0, 80), note: text(data.note).slice(0, 250),
      source: data.source || 'payment', actor: activeActor(), createdAt: time(), reversedAt: null
    };
    const rows = payments();
    rows.unshift(row);
    db_set(PAYMENT_KEY, rows);
    return row;
  }

  window.crm21OpenNewDebt = function openNewDebt() {
    if (!mayWrite()) return;
    if (!customers().some(customer => customer.active !== false)) {
      notify('Qarzdorlik yaratishdan oldin faol mijoz qo‘shing.', true);
      if (typeof switchView === 'function') switchView('customers');
      return;
    }
    byId('dbtTotal').value = '';
    byId('dbtPaid').value = '0';
    if (byId('crm21DebtInvoice')) byId('crm21DebtInvoice').value = '';
    if (byId('crm21DebtNote')) byId('crm21DebtNote').value = '';
    resetDebtDueDate();
    new bootstrap.Modal(byId('modalAddDebt')).show();
  };

  window.crm21OpenPayment = function openPayment(debtId) {
    if (!mayWrite()) return;
    const debt = debts().find(row => row.id === debtId);
    if (!debt || !amount(debt.remaining) || debt.status === 'Bekor qilingan') { notify('Bu qarz bo‘yicha to‘lov qabul qilib bo‘lmaydi.', true); return; }
    byId('crm21PaymentDebtId').value = debt.id;
    byId('crm21PaymentCustomer').textContent = debt.customer;
    byId('crm21PaymentBalance').textContent = displayMoney(debt.remaining);
    byId('crm21PaymentAmount').value = String(amount(debt.remaining));
    byId('crm21PaymentAmount').max = String(amount(debt.remaining));
    byId('crm21PaymentDate').value = today();
    byId('crm21PaymentMethod').value = 'Naqd';
    byId('crm21PaymentReference').value = '';
    byId('crm21PaymentNote').value = '';
    new bootstrap.Modal(byId('crm21PaymentModal')).show();
    setTimeout(() => { byId('crm21PaymentAmount')?.focus(); byId('crm21PaymentAmount')?.select(); }, 160);
  };

  window.crm21SavePayment = function savePayment() {
    if (!mayWrite()) return;
    const id = byId('crm21PaymentDebtId').value;
    const value = amount(byId('crm21PaymentAmount').value);
    const date = validDate(byId('crm21PaymentDate').value);
    const rows = debts();
    const debt = rows.find(row => row.id === id);
    if (!debt || debt.status === 'Bekor qilingan') { notify('Qarzdorlik topilmadi yoki bekor qilingan.', true); return; }
    if (!value || value > amount(debt.remaining)) { notify(`To‘lov 1 so‘mdan ${displayMoney(debt.remaining)}gacha bo‘lishi kerak.`, true); return; }
    if (!date) { notify('To‘lov sanasini kiriting.', true); return; }
    const record = addPaymentRecord(debt, { amount: value, date, method: byId('crm21PaymentMethod').value, reference: byId('crm21PaymentReference').value, note: byId('crm21PaymentNote').value });
    debt.paid = amount(debt.paid) + value;
    debt.remaining = Math.max(0, amount(debt.total) - amount(debt.paid));
    debt.lastPaymentAt = time();
    debt.updatedAt = time();
    debt.status = !debt.remaining ? 'Yopilgan' : paymentStatus(debt, customers().find(customer => customer.id === debt.customerId));
    db_set(DB_KEYS.debts, rows);
    syncCreditSale(debt);
    log(`Qarz to‘lovi: ${debt.customer} · ${record.id} · ${displayMoney(value)} · ${record.method}`);
    bootstrap.Modal.getInstance(byId('crm21PaymentModal'))?.hide();
    notify(`${debt.customer}: ${displayMoney(value)} to‘lov qabul qilindi.`);
    if (typeof renderAll === 'function') renderAll();
    refreshAll();
  };

  window.crm21ReversePayment = function reversePayment(paymentId) {
    if (!isAdmin()) { notify('To‘lovni faqat administrator bekor qilishi mumkin.', true); return; }
    const entries = payments();
    const payment = entries.find(row => row.id === paymentId);
    if (!payment || payment.reversedAt) return;
    if (payment.source === 'initial') { notify('Boshlang‘ich to‘lovni ushbu oynadan bekor qilib bo‘lmaydi.', true); return; }
    if (!window.confirm(`${displayMoney(payment.amount)} to‘lovni bekor qilasizmi? Qarz qoldig‘i qayta hisoblanadi.`)) return;
    const list = debts();
    const debt = list.find(row => row.id === payment.debtId);
    if (!debt || debt.status === 'Bekor qilingan') { notify('Faol qarzdorlik topilmadi.', true); return; }
    payment.reversedAt = time();
    payment.reversedBy = activeActor();
    db_set(PAYMENT_KEY, entries);
    debt.paid = Math.max(0, amount(debt.paid) - amount(payment.amount));
    debt.remaining = Math.max(0, amount(debt.total) - amount(debt.paid));
    debt.updatedAt = time();
    debt.status = paymentStatus(debt, customers().find(customer => customer.id === debt.customerId));
    db_set(DB_KEYS.debts, list);
    syncCreditSale(debt);
    log(`Qarz to‘lovi bekor qilindi: ${payment.id} · ${debt.customer} · ${displayMoney(payment.amount)}`);
    notify('To‘lov bekor qilindi va qarz qayta hisoblandi.');
    if (typeof renderAll === 'function') renderAll();
    refreshAll();
  };

  window.crm21OpenDebtEdit = function openDebtEdit(id) {
    if (!mayWrite()) return;
    const debt = debts().find(row => row.id === id);
    if (!debt) return;
    byId('crm21EditDebtId').value = id;
    byId('crm21EditDebtDue').value = validDate(debt.dueDate) || addDays(today(), 30);
    byId('crm21EditDebtInvoice').value = debt.invoiceNo || '';
    byId('crm21EditDebtNote').value = debt.note || '';
    new bootstrap.Modal(byId('crm21DebtEditModal')).show();
  };

  window.crm21SaveDebtEdit = function saveDebtEdit() {
    if (!mayWrite()) return;
    const rows = debts();
    const debt = rows.find(row => row.id === byId('crm21EditDebtId').value);
    const due = validDate(byId('crm21EditDebtDue').value);
    if (!debt || !due) { notify('To‘lov muddatini to‘g‘ri kiriting.', true); return; }
    debt.dueDate = due;
    debt.invoiceNo = text(byId('crm21EditDebtInvoice').value).slice(0, 80) || debt.invoiceNo;
    debt.note = text(byId('crm21EditDebtNote').value).slice(0, 500);
    debt.updatedAt = time();
    db_set(DB_KEYS.debts, rows);
    syncCreditSale(debt);
    bootstrap.Modal.getInstance(byId('crm21DebtEditModal'))?.hide();
    log(`Qarz shartlari yangilandi: ${debt.customer} · muddat ${due}`);
    notify('Qarzdorlik ma’lumotlari saqlandi.');
    if (typeof renderAll === 'function') renderAll();
    refreshAll();
  };

  window.crm21UpdateFilter = function updateFilter(key, value) {
    filters[key] = text(value);
    renderDebtTable();
  };

  window.crm21ResetFilters = function resetFilters() {
    Object.assign(filters, { query: '', status: '', customerId: '', from: '', to: '', sort: 'due_asc' });
    for (const id of ['crm21Search', 'crm21StatusFilter', 'crm21CustomerFilter', 'crm21DateFrom', 'crm21DateTo']) if (byId(id)) byId(id).value = '';
    renderDebtTable();
  };

  window.crm21Remind = async function remind(debtId) {
    const debt = debts().find(row => row.id === debtId);
    if (!debt) return;
    const customer = customers().find(row => row.id === debt.customerId);
    const message = `Assalomu alaykum, ${debt.customer}. ${debt.invoiceNo || debt.id} bo‘yicha ${displayMoney(debt.remaining)} qarzdorlik mavjud. To‘lov muddati: ${debt.dueDate || 'kelishuv asosida'}. Iltimos, to‘lov haqida bizga xabar bering.`;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(message);
      else window.prompt('Eslatma matnidan nusxa oling:', message);
      log(`Qarz eslatmasi tayyorlandi: ${debt.customer} · ${displayMoney(debt.remaining)}`);
      notify(`Eslatma nusxalandi${customer?.phone ? `: ${customer.phone}` : ''}.`);
    } catch (_) { window.prompt('Eslatma matnidan nusxa oling:', message); }
  };

  function timelineFor(customerId) {
    const customerDebts = debts().filter(debt => debt.customerId === customerId)
      .map(debt => ({ id: debt.id, kind: 'debt', date: debt.createdAt || debt.date, title: `Qarz yaratildi: ${displayMoney(debt.total)}`, note: `${debt.invoiceNo || debt.id} · muddat ${debt.dueDate || '—'}` }));
    const customerPayments = payments().filter(payment => payment.customerId === customerId)
      .map(payment => ({ id: payment.id, kind: payment.reversedAt ? 'overdue' : 'payment', date: payment.createdAt || payment.date, title: `${payment.reversedAt ? 'Bekor qilingan to‘lov' : 'To‘lov qabul qilindi'}: ${displayMoney(payment.amount)}`, note: `${payment.method} · ${payment.actor}${payment.note ? ` · ${payment.note}` : ''}`, payment }));
    const notes = customerNotes().filter(note => note.customerId === customerId)
      .map(note => ({ id: note.id, kind: 'note', date: note.createdAt, title: note.text, note: note.actor }));
    return [...customerDebts, ...customerPayments, ...notes].sort((left, right) => String(right.date).localeCompare(String(left.date)));
  }

  function profileContent(customer, selected, customerDebts, customerPayments, sales) {
    if (selected === 'debts') {
      return customerDebts.length ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Hujjat</th><th>Muddat</th><th>Qoldiq</th><th>Holat</th><th></th></tr></thead><tbody>${customerDebts.map(debt => `<tr><td class="crm21-mono">${escape(debt.invoiceNo)}</td><td>${escape(debt.dueDate)}</td><td>${escape(displayMoney(debt.remaining))}</td><td>${badge(stateFor(debt, customer))}</td><td>${amount(debt.remaining) && debt.status !== 'Bekor qilingan' ? `<button class="crm21-icon-btn pay" onclick="crm21OpenPayment('${escape(debt.id)}')"><i class="bi bi-cash-coin"></i></button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="crm21-empty">Mijozda qarzdorlik yo‘q.</div>';
    }
    if (selected === 'payments') {
      return customerPayments.length ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Sana</th><th>Summa</th><th>Usul</th><th>Hujjat</th><th></th></tr></thead><tbody>${customerPayments.map(payment => `<tr><td>${escape(payment.date)}</td><td>${escape(displayMoney(payment.amount))}${payment.reversedAt ? '<div class="crm21-meta crm21-overdue">Bekor qilingan</div>' : ''}</td><td>${escape(payment.method)}</td><td>${escape(payment.reference || payment.id)}</td><td>${isAdmin() && !payment.reversedAt && payment.source !== 'initial' ? `<button class="crm21-icon-btn danger" onclick="crm21ReversePayment('${escape(payment.id)}')" title="To‘lovni bekor qilish"><i class="bi bi-arrow-counterclockwise"></i></button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="crm21-empty">To‘lovlar hali mavjud emas.</div>';
    }
    if (selected === 'sales') {
      return sales.length ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Sana</th><th>Mahsulot</th><th>Soni</th><th>Jami</th></tr></thead><tbody>${sales.slice(0, 50).map(sale => `<tr><td>${escape(sale.date)}</td><td>${escape(sale.name || sale.sku)}</td><td>${escape(sale.qty)}</td><td>${escape(displayMoney(sale.total))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="crm21-empty">Mijozga biriktirilgan sotuvlar yo‘q.</div>';
    }
    const events = timelineFor(customer.id);
    return `<div class="crm21-timeline">${events.length ? events.map(event => `<div class="crm21-event ${escape(event.kind)}"><div class="crm21-event-title">${escape(event.title)}</div><div class="crm21-event-note">${escape(String(event.date || '').replace('T', ' ').slice(0, 16))}${event.note ? ` · ${escape(event.note)}` : ''}</div></div>`).join('') : '<div class="crm21-empty">Harakatlar hali mavjud emas.</div>'}</div><div class="crm21-note-form"><input class="form-control" id="crm21NewNote" placeholder="Mijoz bo‘yicha eslatma yozing..." maxlength="500"><button class="btn btn-accent" onclick="crm21AddNote()"><i class="bi bi-plus-lg"></i></button></div>`;
  }

  function renderProfile() {
    const root = byId('crm21ProfileBody');
    const customer = customers().find(row => row.id === selectedCustomerId);
    if (!root || !customer) return;
    const customerDebts = debts().filter(debt => debt.customerId === customer.id);
    const customerPayments = payments().filter(payment => payment.customerId === customer.id);
    const sales = db_get(DB_KEYS.sales).filter(sale => sale.customerId === customer.id);
    const balance = openBalance(customer.id);
    const paid = customerPayments.filter(payment => !payment.reversedAt).reduce((sum, payment) => sum + amount(payment.amount), 0);
    const tabs = [['overview', 'Tarix'], ['debts', `Qarzlar · ${customerDebts.length}`], ['payments', `To‘lovlar · ${customerPayments.length}`], ['sales', `Xaridlar · ${sales.length}`]];
    root.innerHTML = `<div class="crm21-profile-grid"><div class="crm21-profile-panel"><div class="crm21-avatar">${escape(text(customer.name).slice(0, 1).toUpperCase())}</div><div class="crm21-profile-name">${escape(customer.name)}</div><div class="crm21-meta">${escape(customer.code || customer.id)} · ${escape(customer.segment || 'Yangi')}</div>
      <div class="crm21-profile-line"><span>Telefon</span><b>${escape(customer.phone || '—')}</b></div><div class="crm21-profile-line"><span>Telegram</span><b>${escape(customer.telegram || '—')}</b></div><div class="crm21-profile-line"><span>Manzil</span><b>${escape(customer.address || '—')}</b></div><div class="crm21-profile-line"><span>Kredit limiti</span><b>${escape(displayMoney(customer.limit))}</b></div><div class="crm21-profile-line"><span>Joriy qarz</span><b>${escape(displayMoney(balance))}</b></div><div class="crm21-profile-line"><span>Undirilgan</span><b>${escape(displayMoney(paid))}</b></div><div class="crm21-profile-line"><span>Qarz muddati</span><b>${escape(customer.creditDays || 30)} kun</b></div>
      <div class="crm21-profile-actions mt-3"><button class="btn btn-outline-erp btn-sm-erp" onclick="v11OpenCustomerModal('${escape(customer.id)}')"><i class="bi bi-pencil"></i> Tahrirlash</button>${customer.phone ? `<a class="btn btn-outline-erp btn-sm-erp" href="tel:${escape(phoneDigits(customer.phone))}"><i class="bi bi-telephone"></i> Qo‘ng‘iroq</a>` : ''}</div></div>
      <div><div class="crm21-tabs">${tabs.map(([key, label]) => `<button class="crm21-tab ${selectedProfileTab === key ? 'active' : ''}" onclick="crm21SelectProfileTab('${key}')">${escape(label)}</button>`).join('')}</div>${profileContent(customer, selectedProfileTab, customerDebts, customerPayments, sales)}</div></div>`;
  }

  window.crm21OpenProfile = function openProfile(customerId) {
    const customer = customers().find(row => row.id === customerId);
    if (!customer) { notify('Mijoz topilmadi.', true); return; }
    selectedCustomerId = customer.id;
    selectedProfileTab = 'overview';
    renderProfile();
    new bootstrap.Modal(byId('crm21ProfileModal')).show();
  };

  window.crm21SelectProfileTab = function selectProfileTab(tab) {
    selectedProfileTab = tab;
    renderProfile();
  };

  window.crm21AddNote = function addNote() {
    if (!mayWrite()) return;
    const value = text(byId('crm21NewNote')?.value);
    if (!selectedCustomerId || !value) { notify('Eslatma matnini kiriting.', true); return; }
    const rows = customerNotes();
    rows.unshift({ id: uid('NOTE'), customerId: selectedCustomerId, text: value.slice(0, 500), actor: activeActor(), createdAt: time() });
    db_set(NOTES_KEY, rows);
    log(`Mijoz kartasiga eslatma qo‘shildi: ${customers().find(row => row.id === selectedCustomerId)?.name || selectedCustomerId}`);
    notify('Mijoz kartasiga eslatma saqlandi.');
    renderProfile();
  };

  function customerStatus(customer, balance) {
    if (customer.active === false) return { kind: 'danger', label: 'Nofaol' };
    const overdue = debts().some(debt => debt.customerId === customer.id && stateFor(debt, customer).key === 'overdue');
    if (overdue) return { kind: 'danger', label: 'Muddati o‘tgan' };
    if (balance > amount(customer.limit)) return { kind: 'danger', label: 'Limitdan oshgan' };
    if (balance) return { kind: 'warn', label: 'Qarzdor' };
    return { kind: 'ok', label: 'Faol' };
  }

  function renderCustomerTable() {
    const root = byId('v11CustomerRows');
    if (!installed || !root) return;
    const legacyQuery = typeof v11CustomerQuery !== 'undefined' ? v11CustomerQuery : '';
    const search = text(byId('v11CustomerSearch')?.value || legacyQuery).toLocaleLowerCase('uz');
    const segment = text(byId('crm21CustomerSegmentFilter')?.value);
    const statusFilter = text(byId('crm21CustomerStateFilter')?.value);
    const sort = text(byId('crm21CustomerSort')?.value);
    const all = customers();
    const rows = all.map(customer => ({ customer, balance: openBalance(customer.id), status: customerStatus(customer, openBalance(customer.id)) }))
      .filter(({ customer, balance, status }) => {
        if (search && ![customer.code, customer.name, customer.phone, customer.phone2, customer.address, customer.taxId, customer.telegram, customer.note]
          .some(value => text(value).toLocaleLowerCase('uz').includes(search))) return false;
        if (segment && text(customer.segment || 'Yangi') !== segment) return false;
        if (statusFilter === 'active' && customer.active === false) return false;
        if (statusFilter === 'inactive' && customer.active !== false) return false;
        if (statusFilter === 'debt' && !balance) return false;
        if (statusFilter === 'overdue' && status.label !== 'Muddati o‘tgan') return false;
        return true;
      })
      .sort((left, right) => sort === 'debt_desc' ? right.balance - left.balance
        : sort === 'recent' ? String(right.customer.createdAt || '').localeCompare(String(left.customer.createdAt || ''))
          : text(left.customer.name).localeCompare(text(right.customer.name)));
    if (byId('v11CustTotal')) byId('v11CustTotal').textContent = all.length;
    if (byId('v11CustActive')) byId('v11CustActive').textContent = all.filter(customer => customer.active !== false).length;
    if (byId('v11CustDebt')) byId('v11CustDebt').textContent = displayMoney(all.reduce((sum, customer) => sum + openBalance(customer.id), 0));
    if (byId('v11CustOverLimit')) byId('v11CustOverLimit').textContent = all.filter(customer => openBalance(customer.id) > amount(customer.limit)).length;
    root.innerHTML = rows.map(({ customer, balance, status }) => {
      const limit = amount(customer.limit);
      const percent = limit ? Math.min(100, Math.round(balance / limit * 100)) : balance ? 100 : 0;
      const latest = timelineFor(customer.id)[0]?.date || customer.updatedAt || customer.createdAt || '';
      return `<tr><td><span class="mono">${escape(customer.code || customer.id)}</span></td><td><button type="button" class="btn p-0 text-start" onclick="crm21OpenProfile('${escape(customer.id)}')"><b>${escape(customer.name)}</b></button><div class="crm21-meta">${escape(customer.type || 'Jismoniy shaxs')} · ${escape(customer.segment || 'Yangi')}</div></td>
        <td>${escape(customer.phone || '—')}${customer.telegram ? `<div class="crm21-meta">${escape(customer.telegram)}</div>` : ''}</td><td>${escape(customer.address || '—')}</td><td class="mono">${escape(displayMoney(limit))}<div class="v11-limit-bar"><span style="width:${percent}%"></span></div></td><td class="mono"><b>${escape(displayMoney(balance))}</b></td><td data-v13-bonus-cell><span class="v13-bonus-chip">${escape(fmt(amount(customer.bonusPoints)))} ball</span></td><td class="mono">${escape(displayMoney(Math.max(0, limit - balance)))}</td><td>${badge(status)}</td><td><div class="crm21-meta">${escape(String(latest).replace('T', ' ').slice(0, 16) || '—')}</div></td><td><div class="v11-customer-actions"><button class="crm21-icon-btn" onclick="crm21OpenProfile('${escape(customer.id)}')" title="Mijoz kartasi"><i class="bi bi-person-vcard"></i></button><button class="crm21-icon-btn" onclick="v11OpenCustomerModal('${escape(customer.id)}')" title="Tahrirlash"><i class="bi bi-pencil"></i></button>${isAdmin() ? `<button class="crm21-icon-btn danger" onclick="v11DeleteCustomer('${escape(customer.id)}')" title="O‘chirish"><i class="bi bi-trash"></i></button>` : ''}</div></td></tr>`;
    }).join('') || '<tr><td colspan="11"><div class="crm21-empty"><i class="bi bi-person-x"></i>Mijoz topilmadi.</div></td></tr>';
  }

  function setCustomerExtraFields(customer) {
    if (byId('crm21CustomerSegment')) byId('crm21CustomerSegment').value = customer?.segment || 'Yangi';
    if (byId('crm21CustomerTelegram')) byId('crm21CustomerTelegram').value = customer?.telegram || '';
    if (byId('crm21CustomerCreditDays')) byId('crm21CustomerCreditDays').value = String(customer?.creditDays || settings().defaultCreditDays);
    if (byId('crm21CustomerEmail')) byId('crm21CustomerEmail').value = customer?.email || '';
    if (byId('crm21CustomerBirthday')) byId('crm21CustomerBirthday').value = validDate(customer?.birthday);
  }

  function validateCustomerExtras() {
    const phone = phoneDigits(byId('v11CustomerPhone')?.value);
    if (phone && !(phone.length === 12 && phone.startsWith('998')) && phone.length !== 9) {
      notify('Telefonni +998 XX XXX XX XX formatida kiriting.', true);
      return false;
    }
    const email = text(byId('crm21CustomerEmail')?.value);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      notify('Email manzilini to‘g‘ri kiriting.', true);
      return false;
    }
    const days = Number(byId('crm21CustomerCreditDays')?.value || 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      notify('Qarz muddati 1 kundan 365 kungacha bo‘lishi kerak.', true);
      return false;
    }
    return true;
  }

  function applyCustomerExtras(id) {
    const rows = customers();
    const customer = rows.find(row => row.id === id);
    if (!customer) return;
    Object.assign(customer, {
      segment: text(byId('crm21CustomerSegment')?.value) || 'Yangi',
      telegram: text(byId('crm21CustomerTelegram')?.value).slice(0, 80),
      creditDays: Math.max(1, Math.min(365, Number(byId('crm21CustomerCreditDays')?.value) || 30)),
      email: text(byId('crm21CustomerEmail')?.value).slice(0, 160),
      birthday: validDate(byId('crm21CustomerBirthday')?.value),
      updatedAt: time()
    });
    db_set(DB_KEYS.customers, rows);
    const debtRows = debts();
    let updated = false;
    debtRows.forEach(debt => {
      if (debt.customerId === customer.id && debt.customer !== customer.name) { debt.customer = customer.name; updated = true; }
    });
    if (updated) db_set(DB_KEYS.debts, debtRows);
    refreshAll();
  }

  function rowsForExport() {
    const map = new Map(customers().map(customer => [customer.id, customer]));
    return buildRows().map(({ debt, state }) => ({
      Hujjat: debt.invoiceNo || debt.id, Mijoz: debt.customer, Telefon: map.get(debt.customerId)?.phone || '',
      Sana: debt.date, Muddat: debt.dueDate || '', Jami: amount(debt.total), Tolangan: amount(debt.paid),
      Qoldiq: amount(debt.remaining), Limit: amount(map.get(debt.customerId)?.limit), Holat: state.label,
      Buyurtma: debt.saleOrderId || '', Izoh: debt.note || ''
    }));
  }

  function csvDownload(name, rows) {
    const headers = rows.length ? Object.keys(rows[0]) : ['Ma’lumot'];
    const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const content = '\uFEFF' + [headers.map(cell).join(';'), ...rows.map(row => headers.map(header => cell(row[header])).join(';'))].join('\r\n');
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  window.crm21ExportLedger = function exportLedger() {
    const ledger = rowsForExport();
    const paymentRows = payments().map(payment => ({ ID: payment.id, Sana: payment.date, Mijoz: payment.customer, Summa: amount(payment.amount), Usul: payment.method, Hujjat: payment.reference || '', Izoh: payment.note || '', Xodim: payment.actor, Holat: payment.reversedAt ? 'Bekor qilingan' : 'Tasdiqlangan' }));
    const customerRows = customers().map(customer => ({ Kod: customer.code || customer.id, Mijoz: customer.name, Telefon: customer.phone || '', Telegram: customer.telegram || '', Segment: customer.segment || 'Yangi', Limit: amount(customer.limit), Qarzdorlik: openBalance(customer.id), Manzil: customer.address || '', Email: customer.email || '', Holat: customer.active === false ? 'Nofaol' : 'Faol' }));
    if (typeof XLSX !== 'undefined' && XLSX.utils?.book_new) {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(ledger.length ? ledger : [{ Holat: 'Ma’lumot yo‘q' }]), 'Qarzdorlik');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(paymentRows.length ? paymentRows : [{ Holat: 'To‘lovlar yo‘q' }]), 'Tolovlar');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(customerRows.length ? customerRows : [{ Holat: 'Mijozlar yo‘q' }]), 'Mijozlar');
      XLSX.writeFile(workbook, `smart-retail-qarzdorlik-${today()}.xlsx`);
    } else csvDownload(`smart-retail-qarzdorlik-${today()}.csv`, ledger);
    log(`Professional qarzdorlik reestri eksport qilindi: ${ledger.length} ta hujjat`);
    notify('Qarzdorlik reestri eksport qilindi.');
  };

  function parseCsv(content) {
    const delimiter = content.split(/\r?\n/, 1)[0].includes(';') ? ';' : ',';
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const parseLine = line => {
      const result = []; let value = ''; let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
        else if (character === '"') quoted = !quoted;
        else if (character === delimiter && !quoted) { result.push(value); value = ''; }
        else value += character;
      }
      result.push(value);
      return result;
    };
    const keys = parseLine(lines.shift());
    return lines.map(line => Object.fromEntries(parseLine(line).map((value, index) => [keys[index] || `Ustun${index}`, value])));
  }

  async function importCustomers(event) {
    if (!mayWrite()) return;
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      let entries;
      if (/\.csv$/i.test(file.name)) entries = parseCsv(await file.text());
      else if (typeof XLSX !== 'undefined') {
        const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        entries = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { defval: '' });
      } else throw new Error('Excel kutubxonasi mavjud emas. CSV formatidan foydalaning.');
      if (entries.length > 10_000) throw new Error('Bir martada ko‘pi bilan 10 000 ta mijoz import qilinadi.');
      const rows = customers();
      const knownPhones = new Set(rows.map(customer => phoneDigits(customer.phone)).filter(Boolean));
      let added = 0; let skipped = 0;
      for (const source of entries) {
        const normalized = Object.fromEntries(Object.entries(source).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
        const name = text(normalized.mijoz || normalized.nomi || normalized.name || normalized.customer || normalized.fullname);
        const phone = text(normalized.telefon || normalized.phone || normalized.tel);
        const digits = phoneDigits(phone);
        if (!name || (digits && knownPhones.has(digits))) { skipped += 1; continue; }
        const customer = { id: uid('CUS'), code: `CUS-${Date.now().toString().slice(-7)}-${added + 1}`, name, phone, phone2: text(normalized.qoshimchatelefon || normalized.phone2), address: text(normalized.manzil || normalized.address), taxId: text(normalized.inn || normalized.taxid), limit: amount(normalized.limit || normalized.qarzlimiti || normalized.creditlimit), active: !['false', '0', 'nofaol'].includes(text(normalized.holat || normalized.active).toLowerCase()), type: text(normalized.turi || normalized.type) || 'Jismoniy shaxs', segment: text(normalized.segment) || 'Yangi', telegram: text(normalized.telegram), email: text(normalized.email), note: text(normalized.izoh || normalized.note), creditDays: Math.max(1, Math.min(365, Number(normalized.muddat || normalized.creditdays) || 30)), createdAt: time(), updatedAt: time() };
        rows.unshift(customer);
        if (digits) knownPhones.add(digits);
        added += 1;
      }
      db_set(DB_KEYS.customers, rows);
      log(`Mijozlar import qilindi: ${added} ta qo‘shildi, ${skipped} ta o‘tkazib yuborildi`);
      if (typeof renderAll === 'function') renderAll();
      refreshAll();
      notify(`${added} ta mijoz qo‘shildi${skipped ? `, ${skipped} ta takroriy yoki xato yozuv o‘tkazildi` : ''}.`);
    } catch (error) { notify(`Import xatosi: ${error.message}`, true); }
    finally { event.target.value = ''; }
  }

  const baseRenderCrm = renderCrm;
  renderCrm = function renderProfessionalCrm() {
    const result = baseRenderCrm.apply(this, arguments);
    if (installed) refreshAll();
    return result;
  };

  const baseRenderCustomers = v11RenderCustomers;
  v11RenderCustomers = function renderProfessionalCustomers() {
    const result = baseRenderCustomers.apply(this, arguments);
    if (installed) renderCustomerTable();
    return result;
  };

  const baseOpenCustomer = v11OpenCustomerModal;
  v11OpenCustomerModal = function openProfessionalCustomer(id = '') {
    const customer = id ? customers().find(row => row.id === id) : null;
    const result = baseOpenCustomer.apply(this, arguments);
    setCustomerExtraFields(customer);
    return result;
  };

  const baseSaveCustomer = v11SaveCustomer;
  v11SaveCustomer = function saveProfessionalCustomer() {
    if (!validateCustomerExtras()) return;
    const existingId = text(byId('v11CustomerId')?.value);
    const before = new Set(customers().map(customer => customer.id));
    const result = baseSaveCustomer.apply(this, arguments);
    if (byId('modalV11Customer')?.classList.contains('show')) return result;
    const customer = existingId ? customers().find(row => row.id === existingId) : customers().find(row => !before.has(row.id));
    if (customer) applyCustomerExtras(customer.id);
    return result;
  };

  if (typeof v11DeleteCustomer === 'function') {
    const baseDeleteCustomer = v11DeleteCustomer;
    v11DeleteCustomer = function deleteProfessionalCustomer(id) {
      if (!isAdmin()) { notify('Mijozni faqat administrator o‘chirishi mumkin.', true); return; }
      const hasHistory = debts().some(debt => debt.customerId === id)
        || payments().some(payment => payment.customerId === id)
        || db_get(DB_KEYS.sales).some(sale => sale.customerId === id);
      if (hasHistory) {
        notify('Mijozda moliyaviy tarix mavjud. O‘chirish o‘rniga mijozni nofaol holatga o‘tkazing.', true);
        return;
      }
      return baseDeleteCustomer.apply(this, arguments);
    };
  }

  if (typeof v11ExportCustomers === 'function') {
    const baseExportCustomers = v11ExportCustomers;
    v11ExportCustomers = function exportProfessionalCustomers() {
      if (typeof XLSX !== 'undefined' && XLSX.utils?.book_new) return baseExportCustomers.apply(this, arguments);
      const rows = customers().map(customer => ({ Kod: customer.code || customer.id, Mijoz: customer.name, Telefon: customer.phone || '', Telegram: customer.telegram || '', Segment: customer.segment || 'Yangi', Limit: amount(customer.limit), Qarzdorlik: openBalance(customer.id), Manzil: customer.address || '', Email: customer.email || '', Holat: customer.active === false ? 'Nofaol' : 'Faol' }));
      csvDownload(`smart-retail-mijozlar-${today()}.csv`, rows);
      log(`Mijozlar bazasi CSV eksport qilindi: ${rows.length} ta mijoz`);
      notify('Mijozlar bazasi CSV faylga chiqarildi.');
    };
  }

  if (typeof v13Notifications === 'function') {
    const baseNotifications = v13Notifications;
    v13Notifications = function receivablesNotifications() {
      const rows = baseNotifications().filter(notification => !String(notification.id).startsWith('DEBT:'));
      const allowed = typeof authCanView !== 'function' || authCanView('crm') || authCanView('customers');
      if (!allowed) return rows.slice(0, 100);
      const map = new Map(customers().map(customer => [customer.id, customer]));
      debts().forEach(debt => {
        const status = stateFor(debt, map.get(debt.customerId));
        if (!['overdue', 'today'].includes(status.key)) return;
        rows.push({
          id: `DEBT:${debt.id}`, kind: status.key === 'overdue' ? 'danger' : 'warn',
          icon: status.key === 'overdue' ? 'bi-clock-history' : 'bi-calendar-event',
          title: status.key === 'overdue' ? 'Muddati o‘tgan qarz' : 'Bugun to‘lanadigan qarz',
          text: `${debt.customer} · ${displayMoney(debt.remaining)} · ${status.label}`, view: 'crm'
        });
      });
      return rows.slice(0, 100);
    };
  }

  submitDebt = function submitProfessionalDebt() {
    if (!mayWrite()) return;
    const customer = customers().find(row => row.id === byId('dbtCustomer')?.value);
    const total = amount(byId('dbtTotal')?.value);
    const paid = amount(byId('dbtPaid')?.value);
    const dueDate = validDate(byId('crm21DebtDueDate')?.value);
    if (!customer || !total) { notify('Mijoz va qarz summasini kiriting.', true); return; }
    if (paid > total) { notify('Boshlang‘ich to‘lov jami summadan katta bo‘lishi mumkin emas.', true); return; }
    if (!dueDate) { notify('To‘lov muddatini kiriting.', true); return; }
    const remaining = total - paid;
    if (remaining && !ensureCredit(customer, remaining)) return;
    const debt = { id: uid('DEBT'), customerId: customer.id, customer: customer.name, total, paid, remaining, date: today(), dueDate, invoiceNo: text(byId('crm21DebtInvoice')?.value).slice(0, 80) || `INV-${today().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, note: text(byId('crm21DebtNote')?.value).slice(0, 500), status: !remaining ? 'Yopilgan' : existingStatus(customer, remaining), createdAt: time(), updatedAt: time(), currency: 'UZS', createdBy: activeActor() };
    const rows = debts();
    rows.unshift(debt);
    db_set(DB_KEYS.debts, rows);
    if (paid) addPaymentRecord(debt, { amount: paid, date: today(), method: 'Boshlang‘ich to‘lov', note: 'Qarzdorlik rasmiylashtirilganda qabul qilindi', source: 'initial' });
    log(`Professional qarzdorlik yaratildi: ${debt.customer} · ${debt.invoiceNo} · ${displayMoney(total)} · muddat ${dueDate}`);
    bootstrap.Modal.getInstance(byId('modalAddDebt'))?.hide();
    notify(`${debt.customer} uchun ${displayMoney(remaining)} qarzdorlik saqlandi.`);
    if (typeof renderAll === 'function') renderAll();
    refreshAll();
  };

  function existingStatus(customer, remaining) {
    return openBalance(customer.id) + amount(remaining) > amount(customer.limit) ? 'Muammo' : 'Nazorat';
  }

  payDebt = function payProfessionalDebt(id) {
    window.crm21OpenPayment(id);
  };

  const basePosCheckout = posCheckout;
  posCheckout = function professionalPosCheckout() {
    const payment = byId('paymentType')?.value;
    const beforeIds = new Set(debts().map(debt => debt.id));
    if (payment === 'Qarz') {
      const customer = customers().find(row => row.id === byId('posCustomerSelect')?.value);
      const requested = amount(byId('v7PosDebtAmount')?.value);
      if (!ensureCredit(customer, requested)) return;
    }
    const result = basePosCheckout.apply(this, arguments);
    if (payment === 'Qarz') {
      const rows = debts();
      const created = rows.find(debt => !beforeIds.has(debt.id));
      if (created) {
        const customer = customers().find(row => row.id === created.customerId);
        created.dueDate = validDate(byId('crm21PosDueDate')?.value) || addDays(today(), amount(customer?.creditDays) || settings().defaultCreditDays);
        created.invoiceNo = created.invoiceNo || `INV-${today().replace(/-/g, '')}-${text(created.saleOrderId || created.id).slice(-5)}`;
        created.createdAt = created.createdAt || time();
        created.updatedAt = time();
        created.status = paymentStatus(created, customer);
        db_set(DB_KEYS.debts, rows);
        if (amount(created.paid)) addPaymentRecord(created, { amount: created.paid, date: today(), method: 'Boshlang‘ich to‘lov', source: 'initial', note: 'POS sotuv vaqtida qabul qilindi' });
        syncCreditSale(created);
      }
      if (byId('crm21PosDueDate')) byId('crm21PosDueDate').value = '';
    }
    refreshAll();
    return result;
  };

  window.crm21Refresh = refreshAll;
  window.crm21Version = VERSION;
  window.crm21Data = () => ({ version: VERSION, customers: customers(), debts: debts(), payments: payments(), notes: customerNotes() });
  document.addEventListener('DOMContentLoaded', install);
})();
