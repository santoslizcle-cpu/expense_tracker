// ---------- Config / storage ----------
window.addEventListener('error', (e) => {
  const mc = document.getElementById('mainContent');
  if (mc) {
    mc.innerHTML = `<div class="status-msg error">Error de la app: ${e.message}. Prueba a borrar el caché (Ajustes del navegador → Service Workers → Unregister, y Cache Storage → borrar) y recargar.</div>`;
  }
});

const CONFIG_KEY = 'ledger.config.v1';

function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function setConfig(partial) {
  const cfg = { ...getConfig(), ...partial };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio',
                  'Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function monthLabelFromDate(d) {
  return `${MESES_ES[d.getMonth()]} ${d.getFullYear()}`;
}
function monthSortKey(label) {
  const [name, yearStr] = label.split(' ');
  return parseInt(yearStr, 10) * 12 + MESES_ES.indexOf(name);
}
function shiftMonthLabel(label, delta) {
  const [name, yearStr] = label.split(' ');
  let idx = MESES_ES.indexOf(name);
  let year = parseInt(yearStr, 10);
  idx += delta;
  while (idx < 0) { idx += 12; year -= 1; }
  while (idx > 11) { idx -= 12; year += 1; }
  return `${MESES_ES[idx]} ${year}`;
}

// ---------- API ----------
async function apiGet(action, params = {}) {
  const cfg = getConfig();
  if (!cfg.apiUrl) throw new Error('NO_URL');
  const url = new URL(cfg.apiUrl);
  url.searchParams.set('action', action);
  if (cfg.apiKey) url.searchParams.set('key', cfg.apiKey);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('HTTP_' + res.status);
  const data = await res.json();
  if (data && data.error === 'Unauthorized') throw new Error('Passcode incorrecto');
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function apiPost(action, body = {}) {
  const cfg = getConfig();
  if (!cfg.apiUrl) throw new Error('NO_URL');
  // use text/plain to avoid a CORS preflight OPTIONS request, which Apps Script webapps don't handle
  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, key: cfg.apiKey, ...body })
  });
  if (!res.ok) throw new Error('HTTP_' + res.status);
  const data = await res.json();
  if (data && data.error === 'Unauthorized') throw new Error('Passcode incorrecto');
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ---------- Category icons ----------
const CATEGORY_ICON = {
  Housing:'🏠', Debt:'💳', Education:'🎓', Family:'👪', Subscriptions:'📺',
  Health:'⚕️', Utilities:'💡', Food:'🍽️', Savings:'🏦', Transport:'🚇',
  Insurance:'🛡️', Travel:'✈️', Personal:'👕', Transfer:'🔁', Other:'•'
};

function money(n) {
  const num = Number(n || 0);
  return '€' + num.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function billKey(month, b) {
  return b.ID ? String(b.ID) : `${month}::${b.BillID}`;
}

// ---------- State ----------
// One month is loaded and shown at a time (state.currentMonth / state.monthData),
// navigated with the prev/next arrows. There is no "start month" step — any
// month, including ones with no real data yet, loads and edits the same way.
let state = {
  view: 'month',
  currentMonth: null,
  monthData: null,
  anchorMonth: null,
  loading: false,
  error: null,
  accountFilter: null, // null | 'Checking' | 'Savings' | 'Credit Card'
  billIndex: {}
};

const mainContent = document.getElementById('mainContent');
const monthLabelEl = document.getElementById('monthLabel');
const fab = document.getElementById('fabAdd');
const prevBtn = document.getElementById('prevMonth');
const nextBtn = document.getElementById('nextMonth');

// ---------- Rendering: Month view ----------
function renderMonthView() {
  const m = state.monthData;
  monthLabelEl.innerHTML = escapeHtml(state.currentMonth || '') + (m && m.isAnchor ? ' <span class="anchor-badge">actual</span>' : '');
  prevBtn.disabled = !!(state.anchorMonth && state.currentMonth === state.anchorMonth);

  if (state.loading) {
    mainContent.innerHTML = '<div class="loading">Cargando...</div>';
    fab.style.display = 'none';
    return;
  }

  if (state.error === 'NO_URL') {
    mainContent.innerHTML = `
      <div class="empty-state">
        Todavía no conectaste tu Google Sheet.<br>
        Abre Ajustes (⚙️) y pega la URL de tu Web App.
      </div>`;
    fab.style.display = 'none';
    return;
  }

  if (state.error) {
    mainContent.innerHTML = `
      <div class="status-msg error">No se pudo cargar: ${escapeHtml(state.error)}</div>
      <div class="empty-state">
        Revisa que la URL en Ajustes sea correcta y que el deployment esté activo.
        <div><button class="secondary" id="retryBtn">Reintentar</button></div>
      </div>`;
    document.getElementById('retryBtn').onclick = () => loadMonth(state.currentMonth);
    fab.style.display = 'none';
    return;
  }

  if (!m) {
    mainContent.innerHTML = `<div class="empty-state">No hay datos todavía para ${escapeHtml(state.currentMonth || '')}.</div>`;
    fab.style.display = 'none';
    return;
  }

  const bills = m.bills || [];
  state.billIndex = {};
  bills.forEach(b => { state.billIndex[billKey(m.Month, b)] = { month: m.Month, id: b.ID || null, billId: b.BillID || null }; });

  const filter = state.accountFilter;
  const visibleBills = filter ? bills.filter(b => b['Source Account'] === filter) : bills;
  const totalSpent = bills
    .filter(b => b.Type !== 'Transfer')
    .reduce((s, b) => s + (Number(b['Actual Amount']) || 0), 0);

  let html = `<div class="accounts-row">
    <div class="acct-card checking ${!filter ? 'active' : ''}" data-acct="__all__"><p class="lbl">Gastado</p><p class="val">${money(totalSpent)}</p></div>
    <div class="acct-card savings ${filter === 'Savings' ? 'active' : ''}" data-acct="Savings"><p class="lbl">Savings</p><p class="val">${money(m.savings.end)}</p></div>
    <div class="acct-card cc ${filter === 'Credit Card' ? 'active' : ''}" data-acct="Credit Card"><p class="lbl">CC disponible</p><p class="val">${money(m.creditCard.available)}</p></div>
  </div>
  <div class="month-adjust"><button id="adjustMonthBtn">Ajustar salario / fee / pago de este mes</button></div>`;

  if (filter) {
    html += `<div class="filter-bar"><span>Mostrando solo: ${filter}</span><button id="clearFilterBtn">Ver todos</button></div>`;
  }

  html += `<div class="section-label">Bills por día</div><div class="bills-list">`;
  if (!visibleBills.length) {
    html += `<div class="empty-state" style="margin:8px 20px;">No hay movimientos de ${filter || 'este mes'}.</div>`;
  }
  visibleBills.forEach(b => {
    const icon = CATEGORY_ICON[b.Category] || CATEGORY_ICON.Other;
    const isExtra = b.Type === 'Extra' || b.Type === 'Transfer';
    const paid = b.Paid === 'Y';
    const dayDisplay = (typeof b.Day === 'number') ? b.Day : '·';
    const key = billKey(m.Month, b);
    html += `
      <div class="bill-row ${isExtra ? 'extra' : ''} ${paid ? 'paid' : ''}" data-editable-key="${escapeHtml(key)}">
        <div class="day-badge">${dayDisplay}</div>
        <div class="bill-info">
          <p class="bill-desc">${icon} ${escapeHtml(b.Description || '')}</p>
          <p class="bill-meta">${escapeHtml(b.Category || '')}${isExtra ? ' · ' + (b.Type === 'Transfer' ? 'transferencia' : 'extra') + ' · ' + escapeHtml(b['Source Account'] || '') : ''}</p>
        </div>
        <div class="bill-amt">${money(b['Actual Amount'])}</div>
        <div class="paid-check ${paid ? 'on' : ''}" data-toggle-key="${escapeHtml(key)}">${paid ? '✓' : ''}</div>
      </div>`;
  });
  html += `</div>`;

  mainContent.innerHTML = html;
  fab.style.display = 'block';

  mainContent.querySelectorAll('.acct-card').forEach(el => {
    el.addEventListener('click', () => {
      const which = el.getAttribute('data-acct');
      state.accountFilter = (which === '__all__' || state.accountFilter === which) ? null : which;
      renderMonthView();
    });
  });

  const clearBtn = document.getElementById('clearFilterBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => { state.accountFilter = null; renderMonthView(); });

  document.getElementById('adjustMonthBtn').addEventListener('click', openMonthSettingsSheet);

  mainContent.querySelectorAll('[data-toggle-key]').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const key = el.getAttribute('data-toggle-key');
      const info = state.billIndex[key];
      if (!info) return;
      const nowOn = !el.classList.contains('on');
      el.classList.toggle('on', nowOn);
      el.textContent = nowOn ? '✓' : '';
      try {
        await saveBillChange(info, { Paid: nowOn ? 'Y' : 'N' });
        await loadMonth(state.currentMonth);
      } catch (err) {
        el.classList.toggle('on', !nowOn);
        el.textContent = !nowOn ? '✓' : '';
      }
    });
  });

  mainContent.querySelectorAll('[data-editable-key]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-editable-key');
      openEditSheet(key);
    });
  });
}

async function saveBillChange(info, changes) {
  if (info.id) {
    await apiPost('updateTransaction', { id: info.id, changes });
  } else {
    const res = await apiPost('upsertBill', { month: info.month, billId: info.billId, changes });
    if (res && res.id) info.id = res.id;
  }
}

async function loadMonth(month) {
  state.currentMonth = month;
  state.loading = true;
  state.error = null;
  renderMonthView();
  try {
    const data = await apiGet('getMonths', { from: month, to: month });
    state.monthData = (data && data.months && data.months[0]) || null;
    if (data && data.anchor) state.anchorMonth = data.anchor.month;
    // The backend clamps any request before the anchor month up to the anchor
    // itself — if that happened, resync currentMonth so we don't show the
    // anchor's numbers under the wrong label.
    if (state.monthData && state.monthData.Month !== month) {
      state.currentMonth = state.monthData.Month;
    }
    setConfig({ lastMonth: state.currentMonth });
  } catch (err) {
    state.error = err.message === 'NO_URL' ? 'NO_URL' : err.message;
  }
  state.loading = false;
  renderMonthView();
}

// ---------- Rendering: Forecast / Resumen view ----------
async function renderForecastView() {
  monthLabelEl.textContent = 'Resumen';
  fab.style.display = 'none';
  mainContent.innerHTML = '<div class="loading">Cargando resumen...</div>';
  try {
    const from = state.anchorMonth || state.currentMonth || monthLabelFromDate(new Date());
    const to = shiftMonthLabel(from, 24);
    const data = await apiGet('getMonths', { from, to });
    const months = (data && data.months) || [];
    if (!months.length) {
      mainContent.innerHTML = '<div class="empty-state">No hay datos de resumen todavía.</div>';
      return;
    }
    let html = '<div class="section-label">Próximos meses</div>';
    months.forEach(m => {
      html += `<div class="forecast-row">
        <div class="forecast-month">${escapeHtml(m.Month || '')}${m.isAnchor ? ' <span class="anchor-badge">actual</span>' : (m.hasRealData ? ' <span title="Incluye datos que ya cargaste" style="color:var(--good);">●</span>' : '')}</div>
        <div class="forecast-vals">
          <span>Savings <b>${money(m.savings.end)}</b></span>
          <span>CC <b>${money(m.creditCard.available)}</b></span>
        </div>
      </div>`;
    });
    html += `<p style="font-size:12px;color:var(--muted);margin:8px 20px 0;">● = este mes ya tiene gastos que cargaste, así que el resumen los usa en vez de tus valores por defecto.</p>`;
    mainContent.innerHTML = html;
  } catch (err) {
    mainContent.innerHTML = `<div class="status-msg error">No se pudo cargar el resumen: ${escapeHtml(err.message)}</div>`;
  }
}

// ---------- Navigation ----------
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.getAttribute('data-view');
    if (state.view === 'month') {
      prevBtn.style.visibility = 'visible';
      nextBtn.style.visibility = 'visible';
      renderMonthView();
    } else {
      prevBtn.style.visibility = 'hidden';
      nextBtn.style.visibility = 'hidden';
      renderForecastView();
    }
  });
});

prevBtn.addEventListener('click', () => {
  if (state.view !== 'month' || prevBtn.disabled) return;
  loadMonth(shiftMonthLabel(state.currentMonth, -1));
});
nextBtn.addEventListener('click', () => {
  if (state.view !== 'month') return;
  loadMonth(shiftMonthLabel(state.currentMonth, 1));
});

// ---------- Swipe left/right to change months ----------
let swipeStartX = null;
let swipeStartY = null;

document.addEventListener('touchstart', (e) => {
  if (state.view !== 'month' || e.target.closest('.sheet-overlay.show')) {
    swipeStartX = null;
    return;
  }
  swipeStartX = e.touches[0].clientX;
  swipeStartY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (swipeStartX === null) return;
  const dx = e.changedTouches[0].clientX - swipeStartX;
  const dy = e.changedTouches[0].clientY - swipeStartY;
  swipeStartX = null;
  swipeStartY = null;

  const SWIPE_THRESHOLD = 60;
  if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return; // too short, or more vertical than horizontal
  if (dx < 0) nextBtn.click(); else prevBtn.click();
}, { passive: true });

// ---------- Add Extra sheet ----------
const extraOverlay = document.getElementById('extraOverlay');
let selectedSource = 'Checking';
let selectedExtraPaid = 'Y';

document.getElementById('addExtraBtn').addEventListener('click', () => {
  document.getElementById('extraDesc').value = '';
  document.getElementById('extraAmount').value = '';
  document.getElementById('extraStatus').innerHTML = '';
  selectedSource = 'Checking';
  selectedExtraPaid = 'Y';
  document.querySelectorAll('.source-opt').forEach(o => o.classList.toggle('sel', o.dataset.src === 'Checking'));
  extraOverlay.querySelectorAll('[data-extra-paid]').forEach(o => o.classList.toggle('sel', o.getAttribute('data-extra-paid') === 'Y'));
  extraOverlay.classList.add('show');
});
document.getElementById('closeExtra').addEventListener('click', () => extraOverlay.classList.remove('show'));
document.getElementById('cancelExtra').addEventListener('click', () => extraOverlay.classList.remove('show'));

document.querySelectorAll('.source-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    selectedSource = opt.dataset.src;
    document.querySelectorAll('.source-opt').forEach(o => o.classList.toggle('sel', o === opt));
  });
});

extraOverlay.querySelectorAll('[data-extra-paid]').forEach(opt => {
  opt.addEventListener('click', () => {
    selectedExtraPaid = opt.getAttribute('data-extra-paid');
    extraOverlay.querySelectorAll('[data-extra-paid]').forEach(o => o.classList.toggle('sel', o === opt));
  });
});

document.getElementById('saveExtra').addEventListener('click', async () => {
  const desc = document.getElementById('extraDesc').value.trim();
  const category = document.getElementById('extraCategory').value;
  const amount = parseFloat(document.getElementById('extraAmount').value);
  const statusEl = document.getElementById('extraStatus');

  if (!desc || isNaN(amount) || amount <= 0) {
    statusEl.innerHTML = '<div class="status-msg error">Completa la descripción y un monto válido.</div>';
    return;
  }

  statusEl.innerHTML = '<div class="loading" style="padding:12px 0;">Guardando...</div>';
  try {
    await apiPost('addTransaction', {
      entry: {
        Month: state.currentMonth,
        Day: new Date().getDate(),
        Category: category,
        Description: desc,
        Type: 'Extra',
        'Actual Amount': amount,
        'Source Account': selectedSource,
        Paid: selectedExtraPaid
      }
    });
    extraOverlay.classList.remove('show');
    loadMonth(state.currentMonth);
  } catch (err) {
    statusEl.innerHTML = `<div class="status-msg error">No se pudo guardar: ${escapeHtml(err.message)}</div>`;
  }
});

// ---------- Edit Bill sheet ----------
const editOverlay = document.getElementById('editOverlay');
let editingKey = null;
let editingPaid = 'N';

function openEditSheet(key) {
  const info = state.billIndex[key];
  if (!info) return;
  const bill = (state.monthData.bills || []).find(b => billKey(info.month, b) === key);
  if (!bill) return;

  editingKey = key;
  editingPaid = bill.Paid === 'Y' ? 'Y' : 'N';
  document.getElementById('editTitle').textContent = bill.Description || 'Editar';
  document.getElementById('editAmount').value = bill['Actual Amount'] || '';
  document.getElementById('editStatus').innerHTML = '';
  editOverlay.querySelectorAll('[data-paid]').forEach(o =>
    o.classList.toggle('sel', o.getAttribute('data-paid') === editingPaid)
  );
  editOverlay.classList.add('show');
}

editOverlay.querySelectorAll('[data-paid]').forEach(opt => {
  opt.addEventListener('click', () => {
    editingPaid = opt.getAttribute('data-paid');
    editOverlay.querySelectorAll('[data-paid]').forEach(o => o.classList.toggle('sel', o === opt));
  });
});
document.getElementById('closeEdit').addEventListener('click', () => editOverlay.classList.remove('show'));
document.getElementById('cancelEdit').addEventListener('click', () => editOverlay.classList.remove('show'));
document.getElementById('saveEdit').addEventListener('click', async () => {
  const amount = parseFloat(document.getElementById('editAmount').value);
  const statusEl = document.getElementById('editStatus');
  if (isNaN(amount) || amount < 0) {
    statusEl.innerHTML = '<div class="status-msg error">Ingresa un monto válido.</div>';
    return;
  }
  const info = state.billIndex[editingKey];
  if (!info) return;

  statusEl.innerHTML = '<div class="loading" style="padding:12px 0;">Guardando...</div>';
  try {
    await saveBillChange(info, { 'Actual Amount': amount, Paid: editingPaid });
    editOverlay.classList.remove('show');
    loadMonth(state.currentMonth);
  } catch (err) {
    statusEl.innerHTML = `<div class="status-msg error">No se pudo guardar: ${escapeHtml(err.message)}</div>`;
  }
});

// ---------- Adjust Month sheet (per-month salary / CC fee / CC payment / CC limit) ----------
const monthSettingsOverlay = document.getElementById('monthSettingsOverlay');

function openMonthSettingsSheet() {
  const m = state.monthData;
  if (!m) return;
  document.getElementById('monthSettingsTitle').textContent = `Ajustar ${m.Month}`;
  document.getElementById('msSalary').value = m.salary != null ? m.salary : '';
  document.getElementById('msCcPayment').value = (m.creditCard && m.creditCard.payment != null) ? m.creditCard.payment : '';
  document.getElementById('msCcFee').value = (m.creditCard && m.creditCard.fee != null) ? m.creditCard.fee : '';
  document.getElementById('msCcLimit').value = (m.creditCard && m.creditCard.limit != null) ? m.creditCard.limit : '';
  document.getElementById('monthSettingsStatus').innerHTML = '';
  monthSettingsOverlay.classList.add('show');
}
document.getElementById('closeMonthSettings').addEventListener('click', () => monthSettingsOverlay.classList.remove('show'));
document.getElementById('cancelMonthSettings').addEventListener('click', () => monthSettingsOverlay.classList.remove('show'));
document.getElementById('saveMonthSettings').addEventListener('click', async () => {
  const statusEl = document.getElementById('monthSettingsStatus');
  const changes = {};
  const salary = document.getElementById('msSalary').value;
  const payment = document.getElementById('msCcPayment').value;
  const fee = document.getElementById('msCcFee').value;
  const limit = document.getElementById('msCcLimit').value;
  if (salary !== '') changes.Salary = parseFloat(salary);
  if (payment !== '') changes.CcPayment = parseFloat(payment);
  if (fee !== '') changes.CcFee = parseFloat(fee);
  if (limit !== '') changes.CcLimit = parseFloat(limit);

  statusEl.innerHTML = '<div class="loading" style="padding:12px 0;">Guardando...</div>';
  try {
    await apiPost('setMonthlyOverride', { month: state.currentMonth, changes });
    monthSettingsOverlay.classList.remove('show');
    loadMonth(state.currentMonth);
  } catch (err) {
    statusEl.innerHTML = `<div class="status-msg error">No se pudo guardar: ${escapeHtml(err.message)}</div>`;
  }
});

// ---------- Settings sheet ----------
const settingsOverlay = document.getElementById('settingsOverlay');
document.getElementById('openSettings').addEventListener('click', () => {
  document.getElementById('apiUrlInput').value = getConfig().apiUrl || '';
  document.getElementById('apiKeyInput').value = getConfig().apiKey || '';
  document.getElementById('settingsStatus').innerHTML = '';
  settingsOverlay.classList.add('show');
});
document.getElementById('closeSettings').addEventListener('click', () => settingsOverlay.classList.remove('show'));

document.getElementById('saveSettings').addEventListener('click', () => {
  const url = document.getElementById('apiUrlInput').value.trim();
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!url.startsWith('https://')) {
    document.getElementById('settingsStatus').innerHTML = '<div class="status-msg error">Pega una URL válida (empieza con https://).</div>';
    return;
  }
  setConfig({ apiUrl: url, apiKey: key });
  document.getElementById('settingsStatus').innerHTML = '<div class="status-msg ok">Guardado.</div>';
  setTimeout(() => {
    settingsOverlay.classList.remove('show');
    init();
  }, 500);
});

// ---------- Starting Values / Setup sheet ----------
const setupOverlay = document.getElementById('setupOverlay');

document.getElementById('openSetup').addEventListener('click', async () => {
  settingsOverlay.classList.remove('show');
  setupOverlay.classList.add('show');
  const statusEl = document.getElementById('setupStatus');
  statusEl.innerHTML = '<div class="loading" style="padding:12px 0;">Cargando...</div>';
  try {
    const data = await apiGet('getSetup');
    const s = (data && data.settings) || {};
    const [monthName, monthYear] = String(s.AnchorMonth || '').split(' ');
    document.getElementById('setupAnchorMonthName').value = monthName || MESES_ES[0];
    document.getElementById('setupAnchorMonthYear').value = monthYear || new Date().getFullYear();
    document.getElementById('setupAnchorSavings').value = s.AnchorSavingsEnd != null ? s.AnchorSavingsEnd : '';
    document.getElementById('setupAnchorCcOwed').value = s.AnchorCcOwedEnd != null ? s.AnchorCcOwedEnd : '';
    document.getElementById('setupSalary').value = s.DefaultSalary != null ? s.DefaultSalary : '';
    document.getElementById('setupCcLimit').value = s.DefaultCcLimit != null ? s.DefaultCcLimit : '';
    document.getElementById('setupCcFee').value = s.DefaultCcFee != null ? s.DefaultCcFee : '';
    document.getElementById('setupCcPayment').value = s.DefaultCcPayment != null ? s.DefaultCcPayment : '';
    statusEl.innerHTML = '';
  } catch (err) {
    statusEl.innerHTML = `<div class="status-msg error">No se pudo cargar: ${escapeHtml(err.message)}</div>`;
  }
});
document.getElementById('closeSetup').addEventListener('click', () => setupOverlay.classList.remove('show'));
document.getElementById('cancelSetup').addEventListener('click', () => setupOverlay.classList.remove('show'));

document.getElementById('saveSetup').addEventListener('click', async () => {
  const statusEl = document.getElementById('setupStatus');
  const monthName = document.getElementById('setupAnchorMonthName').value;
  const monthYear = parseInt(document.getElementById('setupAnchorMonthYear').value, 10);
  const fields = {
    AnchorSavingsEnd: document.getElementById('setupAnchorSavings').value,
    AnchorCcOwedEnd: document.getElementById('setupAnchorCcOwed').value,
    DefaultSalary: document.getElementById('setupSalary').value,
    DefaultCcLimit: document.getElementById('setupCcLimit').value,
    DefaultCcFee: document.getElementById('setupCcFee').value,
    DefaultCcPayment: document.getElementById('setupCcPayment').value
  };
  if (!monthName || isNaN(monthYear) || Object.values(fields).some(v => v === '' || isNaN(parseFloat(v)))) {
    statusEl.innerHTML = '<div class="status-msg error">Completa todos los campos con valores válidos.</div>';
    return;
  }

  const changes = { AnchorMonth: `${monthName} ${monthYear}` };
  Object.keys(fields).forEach(key => { changes[key] = parseFloat(fields[key]); });

  statusEl.innerHTML = '<div class="loading" style="padding:12px 0;">Guardando...</div>';
  try {
    await apiPost('setSettings', { changes });
    setupOverlay.classList.remove('show');
    init();
  } catch (err) {
    statusEl.innerHTML = `<div class="status-msg error">No se pudo guardar: ${escapeHtml(err.message)}</div>`;
  }
});

// ---------- Recurring Bills manager ----------
const recurringListOverlay = document.getElementById('recurringListOverlay');
const recurringEditOverlay = document.getElementById('recurringEditOverlay');
let recurringBillsCache = [];
let editingRecurringBillId = null;
let selectedRecSource = 'Checking';
let selectedRecEnvelope = 'N';

async function loadRecurringList() {
  const content = document.getElementById('recurringListContent');
  content.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    const data = await apiGet('getSetup');
    recurringBillsCache = ((data && data.bills) || []).slice().sort(sortByDayAsc);
    if (!recurringBillsCache.length) {
      content.innerHTML = '<div class="empty-state" style="margin:8px 0;">No hay bills recurrentes todavía.</div>';
      return;
    }
    content.innerHTML = '<div class="bills-list">' + recurringBillsCache.map(b => {
      const icon = CATEGORY_ICON[b.Category] || CATEGORY_ICON.Other;
      return `
        <div class="bill-row" data-rec-edit-id="${escapeHtml(b.BillID)}">
          <div class="day-badge">${typeof b.Day === 'number' ? b.Day : '·'}</div>
          <div class="bill-info">
            <p class="bill-desc">${icon} ${escapeHtml(b.Description || '')}</p>
            <p class="bill-meta">${escapeHtml(b.Category || '')} · ${escapeHtml(b['Source Account'] || '')}</p>
          </div>
          <div class="bill-amt">${money(b['Default Amount'])}</div>
        </div>`;
    }).join('') + '</div>';
    content.querySelectorAll('[data-rec-edit-id]').forEach(el => {
      el.addEventListener('click', () => openRecurringEditSheet(el.getAttribute('data-rec-edit-id')));
    });
  } catch (err) {
    content.innerHTML = `<div class="status-msg error">No se pudo cargar: ${escapeHtml(err.message)}</div>`;
  }
}
function sortByDayAsc(a, b) {
  const da = (typeof a.Day === 'number') ? a.Day : 999;
  const db = (typeof b.Day === 'number') ? b.Day : 999;
  return da - db;
}

document.getElementById('openRecurringList').addEventListener('click', () => {
  settingsOverlay.classList.remove('show');
  recurringListOverlay.classList.add('show');
  loadRecurringList();
});
document.getElementById('closeRecurringList').addEventListener('click', () => recurringListOverlay.classList.remove('show'));
document.getElementById('addRecurringBillBtn').addEventListener('click', () => openRecurringEditSheet(null));

function openRecurringEditSheet(billId) {
  const bill = billId ? recurringBillsCache.find(b => b.BillID === billId) : null;
  editingRecurringBillId = billId;
  document.getElementById('recurringEditTitle').textContent = bill ? 'Editar bill recurrente' : 'Nueva bill recurrente';
  document.getElementById('recDay').value = bill && typeof bill.Day === 'number' ? bill.Day : '';
  document.getElementById('recDesc').value = bill ? bill.Description || '' : '';
  document.getElementById('recCategory').value = bill ? bill.Category || 'Other' : 'Housing';
  document.getElementById('recAmount').value = bill ? bill['Default Amount'] || '' : '';
  selectedRecSource = bill ? bill['Source Account'] || 'Checking' : 'Checking';
  selectedRecEnvelope = bill ? (bill.Envelope === 'Y' ? 'Y' : 'N') : 'N';
  recurringEditOverlay.querySelectorAll('[data-rec-src]').forEach(o => o.classList.toggle('sel', o.getAttribute('data-rec-src') === selectedRecSource));
  recurringEditOverlay.querySelectorAll('[data-rec-envelope]').forEach(o => o.classList.toggle('sel', o.getAttribute('data-rec-envelope') === selectedRecEnvelope));
  document.getElementById('deleteRecurringEdit').style.display = bill ? 'block' : 'none';
  document.getElementById('recurringEditStatus').innerHTML = '';
  recurringListOverlay.classList.remove('show');
  recurringEditOverlay.classList.add('show');
}
document.getElementById('closeRecurringEdit').addEventListener('click', () => recurringEditOverlay.classList.remove('show'));
document.getElementById('cancelRecurringEdit').addEventListener('click', () => recurringEditOverlay.classList.remove('show'));

recurringEditOverlay.querySelectorAll('[data-rec-src]').forEach(opt => {
  opt.addEventListener('click', () => {
    selectedRecSource = opt.getAttribute('data-rec-src');
    recurringEditOverlay.querySelectorAll('[data-rec-src]').forEach(o => o.classList.toggle('sel', o === opt));
  });
});
recurringEditOverlay.querySelectorAll('[data-rec-envelope]').forEach(opt => {
  opt.addEventListener('click', () => {
    selectedRecEnvelope = opt.getAttribute('data-rec-envelope');
    recurringEditOverlay.querySelectorAll('[data-rec-envelope]').forEach(o => o.classList.toggle('sel', o === opt));
  });
});

document.getElementById('saveRecurringEdit').addEventListener('click', async () => {
  const statusEl = document.getElementById('recurringEditStatus');
  const day = parseInt(document.getElementById('recDay').value, 10);
  const desc = document.getElementById('recDesc').value.trim();
  const category = document.getElementById('recCategory').value;
  const amount = parseFloat(document.getElementById('recAmount').value);

  if (!desc || isNaN(day) || day < 1 || day > 31 || isNaN(amount) || amount < 0) {
    statusEl.innerHTML = '<div class="status-msg error">Completa el día, descripción y un monto válido.</div>';
    return;
  }

  const bill = {
    Day: day,
    Category: category,
    Description: desc,
    'Default Amount': amount,
    'Source Account': selectedRecSource,
    Envelope: selectedRecEnvelope
  };

  statusEl.innerHTML = '<div class="loading" style="padding:12px 0;">Guardando...</div>';
  try {
    if (editingRecurringBillId) {
      await apiPost('updateRecurringBill', { billId: editingRecurringBillId, changes: bill });
    } else {
      await apiPost('addRecurringBill', { bill });
    }
    recurringEditOverlay.classList.remove('show');
    recurringListOverlay.classList.add('show');
    loadRecurringList();
  } catch (err) {
    statusEl.innerHTML = `<div class="status-msg error">No se pudo guardar: ${escapeHtml(err.message)}</div>`;
  }
});

document.getElementById('deleteRecurringEdit').addEventListener('click', async () => {
  if (!editingRecurringBillId) return;
  if (!confirm('¿Eliminar esta bill recurrente? Los meses que ya la copiaron no cambian.')) return;
  const statusEl = document.getElementById('recurringEditStatus');
  statusEl.innerHTML = '<div class="loading" style="padding:12px 0;">Eliminando...</div>';
  try {
    await apiPost('deleteRecurringBill', { billId: editingRecurringBillId });
    recurringEditOverlay.classList.remove('show');
    recurringListOverlay.classList.add('show');
    loadRecurringList();
  } catch (err) {
    statusEl.innerHTML = `<div class="status-msg error">No se pudo eliminar: ${escapeHtml(err.message)}</div>`;
  }
});

// ---------- Init ----------
function init() {
  const cfg = getConfig();
  const startMonth = cfg.lastMonth || monthLabelFromDate(new Date());
  if (!cfg.apiUrl) {
    state.error = 'NO_URL';
    renderMonthView();
    document.getElementById('openSettings').click();
  } else {
    loadMonth(startMonth);
  }
}
init();

// ---------- Service worker registration ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
