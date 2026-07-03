(function () {
  "use strict";

  const QUEUE_KEY = "prodentry_queue_v1";
  const LAST_KEY = "prodentry_last_v1";
  const ITEMS_CACHE_KEY = "prodentry_items_cache_v1";
  const SESSION_KEY = "prodentry_session_v1";
  const CONFIG_CACHE_KEY = "prodentry_config_cache_v1";

  let ITEMS = [];
  let SERVER_CONFIG = null; // { departments, reasons, sessionTimeoutHours, maxScheduleSlots }
  let selectedItem = null;
  let session = null; // { name, department, loginAt }
  let currentPin = "";
  let loginMode = "supervisor"; // "supervisor" | "admin"
  let adminPin = null; // in-memory only, cleared when Settings closes
  let editingSupervisorPin = null;

  const $ = (id) => document.getElementById(id);

  const els = {
    machine: $("machine"),
    shift: $("shift"),
    scheduleSlot: $("scheduleSlot"),
    itemCodeInput: $("itemCodeInput"),
    itemResults: $("itemResults"),
    selectedItem: $("selectedItem"),
    selectedItemCode: $("selectedItemCode"),
    selectedItemName: $("selectedItemName"),
    clearItem: $("clearItem"),
    scheduledQty: $("scheduledQty"),
    producedQty: $("producedQty"),
    achievementBadge: $("achievementBadge"),
    reason: $("reason"),
    remarks: $("remarks"),
    changeStart: $("changeStart"),
    changeEnd: $("changeEnd"),
    operatorName: $("operatorName"),
    form: $("entryForm"),
    submitBtn: $("submitBtn"),
    toast: $("toast"),
    netPill: $("netPill"),
    pendingPill: $("pendingPill"),
    appShell: $("appShell"),
    loginScreen: $("loginScreen"),
    loginTitle: $("loginTitle"),
    loginBackBtn: $("loginBackBtn"),
    pinDots: $("pinDots"),
    loginError: $("loginError"),
    keypad: $("keypad"),
    sessionBar: $("sessionBar"),
    sessionInfo: $("sessionInfo"),
    switchUserBtn: $("switchUserBtn"),
    settingsBtn: $("settingsBtn"),
    settingsScreen: $("settingsScreen"),
    closeSettingsBtn: $("closeSettingsBtn"),
    supervisorsList: $("supervisorsList"),
    supName: $("supName"),
    supPin: $("supPin"),
    supDept: $("supDept"),
    supSaveBtn: $("supSaveBtn"),
    supCancelBtn: $("supCancelBtn"),
    machDeptSelect: $("machDeptSelect"),
    machinesList: $("machinesList"),
    newMachineInput: $("newMachineInput"),
    addMachineBtn: $("addMachineBtn"),
    newDeptName: $("newDeptName"),
    newDeptMachine: $("newDeptMachine"),
    addDeptBtn: $("addDeptBtn"),
    reasonsList: $("reasonsList"),
    newReasonInput: $("newReasonInput"),
    addReasonBtn: $("addReasonBtn"),
    timeoutInput: $("timeoutInput"),
    slotsInput: $("slotsInput"),
    saveGeneralBtn: $("saveGeneralBtn"),
    newAdminPinInput: $("newAdminPinInput"),
    saveAdminPinBtn: $("saveAdminPinBtn"),
  };

  // ---------- Generic helpers ----------

  function fillSelect(select, values, placeholder) {
    select.innerHTML = "";
    if (placeholder) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = placeholder;
      o.disabled = true;
      o.selected = true;
      select.appendChild(o);
    }
    values.forEach((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      select.appendChild(o);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
  }

  // ---------- Server config (departments/machines, reasons, timeout) ----------

  async function loadServerConfig(forceRefresh) {
    if (!forceRefresh) {
      try {
        const cached = JSON.parse(localStorage.getItem(CONFIG_CACHE_KEY) || "null");
        if (cached) SERVER_CONFIG = cached;
      } catch (e) { /* ignore */ }
    }

    if (CONFIG.APPS_SCRIPT_URL && navigator.onLine) {
      try {
        const res = await fetch(CONFIG.APPS_SCRIPT_URL + "?action=config");
        if (res.ok) {
          const fresh = await res.json();
          if (fresh && fresh.departments) {
            SERVER_CONFIG = fresh;
            localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(fresh));
          }
        }
      } catch (e) { /* keep cached/bootstrap */ }
    }

    if (!SERVER_CONFIG) {
      try {
        const res = await fetch("bootstrap-config.json");
        SERVER_CONFIG = await res.json();
      } catch (e) {
        SERVER_CONFIG = { departments: {}, reasons: [], sessionTimeoutHours: 12, maxScheduleSlots: 4 };
      }
    }
  }

  function populateStaticFields() {
    fillSelect(els.shift, ["Day", "Night"], null);

    const slots = [];
    const maxSlots = (SERVER_CONFIG && SERVER_CONFIG.maxScheduleSlots) || 4;
    for (let i = 1; i <= maxSlots; i++) slots.push(String(i));
    fillSelect(els.scheduleSlot, slots, null);

    els.reason.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— Select if applicable —";
    els.reason.appendChild(blank);
    (SERVER_CONFIG.reasons || []).forEach((r) => {
      const o = document.createElement("option");
      o.value = r;
      o.textContent = r;
      els.reason.appendChild(o);
    });
  }

  function populateMachinesForDept(dept) {
    const machines = (SERVER_CONFIG.departments && SERVER_CONFIG.departments[dept]) || [];
    fillSelect(els.machine, machines, "Select machine");
  }

  // ---------- Remember last machine/shift (speeds up repeat entries) ----------

  function loadLast() {
    try {
      return JSON.parse(localStorage.getItem(LAST_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveLast() {
    localStorage.setItem(LAST_KEY, JSON.stringify({
      machine: els.machine.value,
      shift: els.shift.value,
    }));
  }

  function applyLast() {
    const last = loadLast();
    if (last.machine) els.machine.value = last.machine;
    if (last.shift) els.shift.value = last.shift;
  }

  // ---------- Session (supervisor login) ----------

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function saveSession(s) {
    session = s;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }

  function clearSession() {
    session = null;
    localStorage.removeItem(SESSION_KEY);
  }

  function sessionExpired(s) {
    if (!s || !s.loginAt) return true;
    const hours = (SERVER_CONFIG && SERVER_CONFIG.sessionTimeoutHours) || 12;
    return Date.now() - s.loginAt > hours * 3600 * 1000;
  }

  function enterApp(s) {
    session = s;
    els.loginScreen.classList.add("hidden");
    els.settingsScreen.classList.add("hidden");
    els.appShell.classList.remove("hidden");
    els.sessionBar.classList.remove("hidden");
    els.sessionInfo.textContent = s.name + " · " + s.department;
    populateMachinesForDept(s.department);
    applyLast();
  }

  function openLoginScreen(mode, message) {
    loginMode = mode;
    currentPin = "";
    renderPinDots();
    els.loginTitle.textContent = mode === "admin" ? "Enter admin PIN" : "Enter your PIN";
    els.loginBackBtn.classList.toggle("hidden", mode !== "admin");
    if (message) {
      els.loginError.textContent = message;
      els.loginError.classList.remove("hidden");
    } else {
      els.loginError.classList.add("hidden");
    }
    els.appShell.classList.add("hidden");
    els.settingsScreen.classList.add("hidden");
    els.loginScreen.classList.remove("hidden");
  }

  function renderPinDots() {
    const len = CONFIG.PIN_LENGTH || 4;
    els.pinDots.innerHTML = "";
    for (let i = 0; i < len; i++) {
      const dot = document.createElement("div");
      dot.className = "pin-dot" + (i < currentPin.length ? " filled" : "");
      els.pinDots.appendChild(dot);
    }
  }

  async function attemptLogin(pin) {
    if (!CONFIG.APPS_SCRIPT_URL) {
      openLoginScreen("supervisor", "No server configured yet — set APPS_SCRIPT_URL in config.js.");
      return;
    }
    if (!navigator.onLine) {
      openLoginScreen("supervisor", "Connect to the internet once to log in on this device.");
      return;
    }
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "login", pin: pin, secretToken: CONFIG.SECRET_TOKEN }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        saveSession({ name: data.name, department: data.department, loginAt: Date.now() });
        enterApp(session);
      } else {
        openLoginScreen("supervisor", data.message || "Invalid PIN");
      }
    } catch (e) {
      openLoginScreen("supervisor", "Could not reach the server. Check your connection and try again.");
    }
  }

  async function attemptAdminLogin(pin) {
    if (!CONFIG.APPS_SCRIPT_URL) {
      openLoginScreen("admin", "No server configured yet.");
      return;
    }
    if (!navigator.onLine) {
      openLoginScreen("admin", "Connect to the internet to open Settings.");
      return;
    }
    try {
      const data = await adminPostRaw({ action: "adminLogin", adminPin: pin });
      if (data.status === "ok") {
        adminPin = pin;
        openSettingsScreen();
      } else {
        openLoginScreen("admin", data.message || "Invalid admin PIN");
      }
    } catch (e) {
      openLoginScreen("admin", "Could not reach the server.");
    }
  }

  function handleKeypad(key) {
    els.loginError.classList.add("hidden");
    const len = CONFIG.PIN_LENGTH || 4;
    if (key === "back") {
      currentPin = currentPin.slice(0, -1);
      renderPinDots();
      return;
    }
    if (currentPin.length >= len) return;
    currentPin += key;
    renderPinDots();
    if (currentPin.length === len) {
      if (loginMode === "admin") attemptAdminLogin(currentPin);
      else attemptLogin(currentPin);
    }
  }

  function checkSessionExpiryLoop() {
    setInterval(() => {
      if (session && sessionExpired(session)) {
        clearSession();
        openLoginScreen("supervisor", "Session expired — please log in again.");
      }
    }, 60000);
  }

  // ---------- Admin / Settings ----------

  async function adminPostRaw(payload) {
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ secretToken: CONFIG.SECRET_TOKEN }, payload)),
    });
    return res.json();
  }

  async function adminPost(action, payload) {
    return adminPostRaw(Object.assign({ action: action, adminPin: adminPin }, payload));
  }

  function openSettingsScreen() {
    els.loginScreen.classList.add("hidden");
    els.appShell.classList.add("hidden");
    els.settingsScreen.classList.remove("hidden");
    switchSettingsTab("supervisors");
    populateSupDeptSelect();
    populateMachDeptSelect();
    resetSupervisorForm();
    refreshSupervisorsList();
    refreshMachinesList();
    refreshReasonsList();
    populateGeneralPanel();
  }

  function closeSettingsScreen() {
    adminPin = null;
    els.settingsScreen.classList.add("hidden");
    els.appShell.classList.remove("hidden");
  }

  function switchSettingsTab(tab) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== "panel-" + tab));
  }

  function populateSupDeptSelect() {
    fillSelect(els.supDept, Object.keys(SERVER_CONFIG.departments || {}), null);
  }

  function populateMachDeptSelect() {
    fillSelect(els.machDeptSelect, Object.keys(SERVER_CONFIG.departments || {}), null);
  }

  async function refreshSupervisorsList() {
    const data = await adminPost("listSupervisors", {});
    if (data.status !== "ok") {
      showToast(data.message || "Could not load supervisors");
      return;
    }
    renderSupervisorsList(data.supervisors);
  }

  function renderSupervisorsList(list) {
    els.supervisorsList.innerHTML = "";
    if (!list.length) {
      els.supervisorsList.innerHTML = '<div class="settings-empty">No supervisors yet.</div>';
      return;
    }
    list.forEach((sup) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      row.innerHTML =
        '<div><div class="settings-row-title">' + escapeHtml(sup.name) + '</div>' +
        '<div class="settings-row-sub">PIN ' + escapeHtml(sup.pin) + ' · ' + escapeHtml(sup.department) + '</div></div>' +
        '<div class="settings-row-actions">' +
        '<button type="button" class="link-btn" data-edit="' + escapeHtml(sup.pin) + '">Edit</button>' +
        '<button type="button" class="link-btn link-danger" data-delete="' + escapeHtml(sup.pin) + '">Delete</button>' +
        '</div>';
      els.supervisorsList.appendChild(row);
    });
    els.supervisorsList.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = list.find((x) => x.pin === btn.dataset.edit);
        if (!s) return;
        editingSupervisorPin = s.pin;
        els.supName.value = s.name;
        els.supPin.value = s.pin;
        els.supDept.value = s.department;
        els.supSaveBtn.textContent = "Save changes";
        els.supCancelBtn.classList.remove("hidden");
      });
    });
    els.supervisorsList.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this supervisor?")) return;
        const data = await adminPost("deleteSupervisor", { pin: btn.dataset.delete });
        if (data.status === "ok") {
          showToast("Supervisor removed");
          refreshSupervisorsList();
        } else {
          showToast(data.message || "Could not remove");
        }
      });
    });
  }

  function resetSupervisorForm() {
    editingSupervisorPin = null;
    els.supName.value = "";
    els.supPin.value = "";
    els.supDept.value = "";
    els.supSaveBtn.textContent = "Add supervisor";
    els.supCancelBtn.classList.add("hidden");
  }

  function refreshMachinesList() {
    const dept = els.machDeptSelect.value;
    const machines = (SERVER_CONFIG.departments && SERVER_CONFIG.departments[dept]) || [];
    els.machinesList.innerHTML = "";
    if (!machines.length) {
      els.machinesList.innerHTML = '<div class="settings-empty">No machines in this department yet.</div>';
      return;
    }
    machines.forEach((m) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      row.innerHTML =
        '<div class="settings-row-title">' + escapeHtml(m) + '</div>' +
        '<button type="button" class="remove-x" data-remove="' + escapeHtml(m) + '" aria-label="Remove">×</button>';
      els.machinesList.appendChild(row);
    });
    els.machinesList.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this machine?")) return;
        const data = await adminPost("removeMachine", { department: dept, machine: btn.dataset.remove });
        if (data.status === "ok") {
          showToast("Machine removed");
          await loadServerConfig(true);
          refreshMachinesList();
        } else {
          showToast(data.message || "Could not remove");
        }
      });
    });
  }

  function refreshReasonsList() {
    const reasons = SERVER_CONFIG.reasons || [];
    els.reasonsList.innerHTML = "";
    if (!reasons.length) {
      els.reasonsList.innerHTML = '<div class="settings-empty">No reasons yet.</div>';
      return;
    }
    reasons.forEach((r) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      row.innerHTML =
        '<div class="settings-row-title">' + escapeHtml(r) + '</div>' +
        '<button type="button" class="remove-x" data-remove="' + escapeHtml(r) + '" aria-label="Remove">×</button>';
      els.reasonsList.appendChild(row);
    });
    els.reasonsList.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this reason?")) return;
        const data = await adminPost("removeReason", { reason: btn.dataset.remove });
        if (data.status === "ok") {
          showToast("Reason removed");
          await loadServerConfig(true);
          refreshReasonsList();
          populateStaticFields();
        } else {
          showToast(data.message || "Could not remove");
        }
      });
    });
  }

  function populateGeneralPanel() {
    els.timeoutInput.value = (SERVER_CONFIG && SERVER_CONFIG.sessionTimeoutHours) || 12;
    els.slotsInput.value = (SERVER_CONFIG && SERVER_CONFIG.maxScheduleSlots) || 4;
    els.newAdminPinInput.value = "";
  }

  // ---------- Item master (bundled + refreshed from server when online) ----------

  async function loadItems() {
    try {
      const cached = JSON.parse(localStorage.getItem(ITEMS_CACHE_KEY) || "null");
      if (cached && Array.isArray(cached) && cached.length) ITEMS = cached;
    } catch (e) { /* ignore */ }

    if (!ITEMS.length) {
      try {
        const res = await fetch("items.json");
        ITEMS = await res.json();
      } catch (e) {
        ITEMS = [];
      }
    }

    refreshItemsFromServer();
  }

  async function refreshItemsFromServer() {
    if (!CONFIG.APPS_SCRIPT_URL || !navigator.onLine) return;
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL + "?action=items", { method: "GET" });
      if (!res.ok) return;
      const fresh = await res.json();
      if (Array.isArray(fresh) && fresh.length) {
        ITEMS = fresh;
        localStorage.setItem(ITEMS_CACHE_KEY, JSON.stringify(fresh));
      }
    } catch (e) { /* silent */ }
  }

  function searchItems(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const starts = [];
    const contains = [];
    for (const it of ITEMS) {
      const code = String(it.code).toLowerCase();
      const name = String(it.name).toLowerCase();
      if (code.startsWith(q)) starts.push(it);
      else if (code.includes(q) || name.includes(q)) contains.push(it);
      if (starts.length + contains.length > 60) break;
    }
    return starts.concat(contains).slice(0, 20);
  }

  function renderItemResults(list) {
    els.itemResults.innerHTML = "";
    if (!list.length) {
      els.itemResults.classList.add("hidden");
      return;
    }
    list.forEach((it) => {
      const row = document.createElement("div");
      row.className = "item-row";
      row.innerHTML =
        '<div class="item-code">' + escapeHtml(it.code) + "</div>" +
        '<div class="item-name">' + escapeHtml(it.name) + "</div>";
      row.addEventListener("click", () => selectItem(it));
      els.itemResults.appendChild(row);
    });
    els.itemResults.classList.remove("hidden");
  }

  function selectItem(it) {
    selectedItem = it;
    els.selectedItemCode.textContent = it.code;
    els.selectedItemName.textContent = it.name;
    els.selectedItem.classList.remove("hidden");
    els.itemCodeInput.value = "";
    els.itemCodeInput.classList.add("hidden");
    els.itemResults.classList.add("hidden");
  }

  function clearItem() {
    selectedItem = null;
    els.selectedItem.classList.add("hidden");
    els.itemCodeInput.classList.remove("hidden");
    els.itemCodeInput.value = "";
    els.itemCodeInput.focus();
  }

  // ---------- Achievement badge ----------

  function updateAchievement() {
    const sched = parseFloat(els.scheduledQty.value);
    const prod = parseFloat(els.producedQty.value);
    if (isNaN(sched) || isNaN(prod) || sched <= 0) {
      els.achievementBadge.classList.add("hidden");
      return;
    }
    const pct = Math.min(100, Math.round((prod / sched) * 100));
    els.achievementBadge.textContent = pct + "% of schedule";
    els.achievementBadge.classList.remove("hidden", "ach-green", "ach-amber", "ach-red");
    if (pct >= 95) els.achievementBadge.classList.add("ach-green");
    else if (pct >= 70) els.achievementBadge.classList.add("ach-amber");
    else els.achievementBadge.classList.add("ach-red");
  }

  // ---------- Offline queue ----------

  function getQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function setQueue(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    updatePendingPill(q.length);
  }

  function updatePendingPill(count) {
    if (count > 0) {
      els.pendingPill.textContent = count + " queued";
      els.pendingPill.classList.remove("hidden");
    } else {
      els.pendingPill.classList.add("hidden");
    }
  }

  function enqueue(entry) {
    const q = getQueue();
    q.push(entry);
    setQueue(q);
  }

  async function flushQueue() {
    if (!navigator.onLine || !CONFIG.APPS_SCRIPT_URL) return;
    let q = getQueue();
    if (!q.length) return;
    const remaining = [];
    for (const entry of q) {
      const ok = await sendToServer(entry);
      if (!ok) remaining.push(entry);
    }
    setQueue(remaining);
    if (remaining.length === 0) showToast("Synced all queued entries");
  }

  async function sendToServer(entry) {
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(entry),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data && data.status === "ok";
    } catch (e) {
      return false;
    }
  }

  // ---------- Network status ----------

  function updateNetPill() {
    if (navigator.onLine) {
      els.netPill.textContent = "Online";
      els.netPill.classList.remove("pill-offline");
      els.netPill.classList.add("pill-online");
    } else {
      els.netPill.textContent = "Offline";
      els.netPill.classList.remove("pill-online");
      els.netPill.classList.add("pill-offline");
    }
  }

  // ---------- Form reset between entries ----------

  function resetEntryFields() {
    clearItem();
    els.scheduledQty.value = "";
    els.producedQty.value = "";
    els.achievementBadge.classList.add("hidden");
    els.reason.value = "";
    els.remarks.value = "";
    els.changeStart.value = "";
    els.changeEnd.value = "";
    els.operatorName.value = "";
  }

  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ---------- Event wiring: login + navigation ----------

  els.keypad.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-k]");
    if (!btn) return;
    handleKeypad(btn.dataset.k);
  });

  els.loginBackBtn.addEventListener("click", () => {
    els.loginScreen.classList.add("hidden");
    els.appShell.classList.remove("hidden");
  });

  els.switchUserBtn.addEventListener("click", () => {
    clearSession();
    openLoginScreen("supervisor");
  });

  els.settingsBtn.addEventListener("click", () => {
    openLoginScreen("admin");
  });

  els.closeSettingsBtn.addEventListener("click", closeSettingsScreen);

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSettingsTab(btn.dataset.tab));
  });

  // ---------- Event wiring: settings forms ----------

  els.supSaveBtn.addEventListener("click", async () => {
    const name = els.supName.value.trim();
    const pin = els.supPin.value.trim();
    const dept = els.supDept.value;
    if (!name || !pin || !dept) {
      showToast("Fill in name, PIN, and department");
      return;
    }
    const data = editingSupervisorPin
      ? await adminPost("updateSupervisor", { originalPin: editingSupervisorPin, name, pin, department: dept })
      : await adminPost("addSupervisor", { name, pin, department: dept });
    if (data.status === "ok") {
      showToast(editingSupervisorPin ? "Supervisor updated" : "Supervisor added");
      resetSupervisorForm();
      refreshSupervisorsList();
    } else {
      showToast(data.message || "Could not save");
    }
  });

  els.supCancelBtn.addEventListener("click", resetSupervisorForm);

  els.machDeptSelect.addEventListener("change", refreshMachinesList);

  els.addMachineBtn.addEventListener("click", async () => {
    const dept = els.machDeptSelect.value;
    const machine = els.newMachineInput.value.trim();
    if (!dept || !machine) {
      showToast("Pick a department and enter a machine name");
      return;
    }
    const data = await adminPost("addMachine", { department: dept, machine });
    if (data.status === "ok") {
      showToast("Machine added");
      els.newMachineInput.value = "";
      await loadServerConfig(true);
      refreshMachinesList();
    } else {
      showToast(data.message || "Could not add");
    }
  });

  els.addDeptBtn.addEventListener("click", async () => {
    const dept = els.newDeptName.value.trim();
    const machine = els.newDeptMachine.value.trim();
    if (!dept || !machine) {
      showToast("Enter a department name and its first machine");
      return;
    }
    const data = await adminPost("addMachine", { department: dept, machine });
    if (data.status === "ok") {
      showToast("Department created");
      els.newDeptName.value = "";
      els.newDeptMachine.value = "";
      await loadServerConfig(true);
      populateMachDeptSelect();
      populateSupDeptSelect();
      els.machDeptSelect.value = dept;
      refreshMachinesList();
    } else {
      showToast(data.message || "Could not create department");
    }
  });

  els.addReasonBtn.addEventListener("click", async () => {
    const reason = els.newReasonInput.value.trim();
    if (!reason) return;
    const data = await adminPost("addReason", { reason });
    if (data.status === "ok") {
      showToast("Reason added");
      els.newReasonInput.value = "";
      await loadServerConfig(true);
      refreshReasonsList();
      populateStaticFields();
    } else {
      showToast(data.message || "Could not add");
    }
  });

  els.saveGeneralBtn.addEventListener("click", async () => {
    const data = await adminPost("updateSettings", {
      sessionTimeoutHours: els.timeoutInput.value,
      maxScheduleSlots: els.slotsInput.value,
    });
    if (data.status === "ok") {
      showToast("Settings saved");
      await loadServerConfig(true);
      populateStaticFields();
    } else {
      showToast(data.message || "Could not save");
    }
  });

  els.saveAdminPinBtn.addEventListener("click", async () => {
    const newPin = els.newAdminPinInput.value.trim();
    const len = CONFIG.PIN_LENGTH || 4;
    if (newPin.length !== len) {
      showToast("Admin PIN must be " + len + " digits");
      return;
    }
    const data = await adminPost("updateSettings", { newAdminPin: newPin });
    if (data.status === "ok") {
      adminPin = newPin;
      showToast("Admin PIN updated");
      els.newAdminPinInput.value = "";
    } else {
      showToast(data.message || "Could not update");
    }
  });

  // ---------- Event wiring: entry form ----------

  els.itemCodeInput.addEventListener("input", () => {
    renderItemResults(searchItems(els.itemCodeInput.value));
  });

  els.clearItem.addEventListener("click", clearItem);

  els.scheduledQty.addEventListener("input", updateAchievement);
  els.producedQty.addEventListener("input", updateAchievement);

  window.addEventListener("online", () => {
    updateNetPill();
    flushQueue();
  });
  window.addEventListener("offline", updateNetPill);

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!session) {
      showToast("Please log in first");
      return;
    }
    if (!selectedItem) {
      showToast("Select an item code first");
      return;
    }
    if (!els.machine.value) {
      showToast("Select a machine");
      return;
    }

    const entry = {
      entryId: uuid(),
      clientTimestamp: new Date().toISOString(),
      secretToken: CONFIG.SECRET_TOKEN,
      department: session.department,
      machine: els.machine.value,
      shift: els.shift.value,
      scheduleSlot: els.scheduleSlot.value,
      itemCode: selectedItem.code,
      itemName: selectedItem.name,
      scheduledQty: els.scheduledQty.value,
      producedQty: els.producedQty.value,
      reason: els.reason.value,
      remarks: els.remarks.value,
      partChangeStart: els.changeStart.value,
      partChangeEnd: els.changeEnd.value,
      operatorName: els.operatorName.value,
      supervisorName: session.name,
    };

    saveLast();

    let sentNow = false;
    if (navigator.onLine && CONFIG.APPS_SCRIPT_URL) {
      sentNow = await sendToServer(entry);
    }

    if (!sentNow) {
      enqueue(entry);
      showToast(CONFIG.APPS_SCRIPT_URL ? "Saved offline — will sync" : "Saved locally (no server configured)");
    } else {
      showToast("Entry saved");
    }

    resetEntryFields();
  });

  // ---------- Init ----------

  async function init() {
    await loadServerConfig(false);
    populateStaticFields();
    await loadItems();
    updateNetPill();
    updatePendingPill(getQueue().length);
    renderPinDots();

    const existing = loadSession();
    if (existing && !sessionExpired(existing)) {
      enterApp(existing);
    } else {
      if (existing) clearSession();
      openLoginScreen("supervisor");
    }

    checkSessionExpiryLoop();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    setInterval(flushQueue, 20000);
    flushQueue();
  }

  init();
})();
