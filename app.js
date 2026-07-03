(function () {
  "use strict";

  const QUEUE_KEY = "prodentry_queue_v1";
  const LAST_KEY = "prodentry_last_v1";
  const ITEMS_CACHE_KEY = "prodentry_items_cache_v1";
  const SESSION_KEY = "prodentry_session_v1";
  const CONFIG_CACHE_KEY = "prodentry_config_cache_v1";

  let ITEMS = [];
  let SERVER_CONFIG = null; // { departments: {dept: [{machine, capacityPerMin}]}, reasons, sessionTimeoutHours, maxScheduleSlots, shiftTimes }
  let selectedItem = null;
  let session = null; // { name, department, loginAt }
  let currentPin = "";
  let loginMode = "supervisor"; // "supervisor" | "admin"
  let adminPin = null; // in-memory only, cleared when Settings closes
  let editingSupervisorPin = null;
  let shiftUsage = null; // latest { usedMinutes, totalMinutes, capacityPerMin, ... } for current machine+shift+today

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
    changeStart: $("changeStart"),
    changeEnd: $("changeEnd"),
    shiftUsageBar: $("shiftUsageBar"),
    shiftUsageLabel: $("shiftUsageLabel"),
    shiftUsagePct: $("shiftUsagePct"),
    shiftUsageFill: $("shiftUsageFill"),
    capacityWarning: $("capacityWarning"),
    scheduledPreview: $("scheduledPreview"),
    scheduledPreviewQty: $("scheduledPreviewQty"),
    producedQty: $("producedQty"),
    achievementBadge: $("achievementBadge"),
    reason: $("reason"),
    remarks: $("remarks"),
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
    newMachineCapacity: $("newMachineCapacity"),
    addMachineBtn: $("addMachineBtn"),
    newDeptName: $("newDeptName"),
    newDeptMachine: $("newDeptMachine"),
    newDeptMachineCapacity: $("newDeptMachineCapacity"),
    addDeptBtn: $("addDeptBtn"),
    reasonsList: $("reasonsList"),
    newReasonInput: $("newReasonInput"),
    addReasonBtn: $("addReasonBtn"),
    dayShiftStartInput: $("dayShiftStartInput"),
    dayShiftEndInput: $("dayShiftEndInput"),
    nightShiftStartInput: $("nightShiftStartInput"),
    nightShiftEndInput: $("nightShiftEndInput"),
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
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3200);
  }

  function todayDateStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function parseHHMM(str) {
    const parts = String(str).split(":");
    const h = Number(parts[0]) || 0;
    const m = Number(parts[1]) || 0;
    return h * 60 + m;
  }

  function computeDurationMinutes(startStr, endStr) {
    if (!startStr || !endStr) return 0;
    const s = parseHHMM(startStr);
    let e = parseHHMM(endStr);
    if (e <= s) e += 24 * 60; // crosses midnight (night shift)
    return e - s;
  }

  // ---------- Server config (departments/machines, reasons, timeout, shift clock) ----------

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
        SERVER_CONFIG = { departments: {}, reasons: [], sessionTimeoutHours: 12, maxScheduleSlots: 4, shiftTimes: {} };
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

  function getDeptMachines(dept) {
    return (SERVER_CONFIG.departments && SERVER_CONFIG.departments[dept]) || [];
  }

  function populateMachinesForDept(dept) {
    const names = getDeptMachines(dept).map((m) => m.machine);
    fillSelect(els.machine, names, "Select machine");
  }

  function getSelectedMachineCapacity() {
    if (!session) return 0;
    const found = getDeptMachines(session.department).find((m) => m.machine === els.machine.value);
    return found ? Number(found.capacityPerMin) || 0 : 0;
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
    refreshShiftUsage();
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

  // ---------- Shift usage (time-based capacity) ----------

  async function fetchShiftUsage(dept, machine, shift) {
    if (!CONFIG.APPS_SCRIPT_URL || !navigator.onLine || !dept || !machine || !shift) return null;
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "getShiftUsage", secretToken: CONFIG.SECRET_TOKEN,
          department: dept, machine: machine, shift: shift, date: todayDateStr(),
        }),
      });
      const data = await res.json();
      if (data && data.status === "ok") return data;
    } catch (e) { /* offline or unreachable */ }
    return null;
  }

  async function refreshShiftUsage() {
    if (!session || !els.machine.value || !els.shift.value) {
      els.shiftUsageBar.classList.add("hidden");
      shiftUsage = null;
      return;
    }
    shiftUsage = await fetchShiftUsage(session.department, els.machine.value, els.shift.value);
    renderShiftUsage();
  }

  function renderShiftUsage() {
    if (!shiftUsage) {
      els.shiftUsageBar.classList.add("hidden");
      return;
    }
    const usedMin = shiftUsage.usedMinutes || 0;
    const totalMin = shiftUsage.totalMinutes || 0;
    const thisMin = computeDurationMinutes(els.changeStart.value, els.changeEnd.value);
    const projected = usedMin + (thisMin > 0 ? thisMin : 0);
    const pct = totalMin > 0 ? Math.round((projected / totalMin) * 100) : 0;

    els.shiftUsageBar.classList.remove("hidden");
    els.shiftUsagePct.textContent = pct + "%";
    els.shiftUsageLabel.textContent =
      "Shift time: " + fmtHM(usedMin) + " used of " + fmtHM(totalMin);
    els.shiftUsageFill.style.width = Math.min(100, pct) + "%";
    els.shiftUsageFill.classList.remove("usage-amber", "usage-red");
    if (pct >= 100) els.shiftUsageFill.classList.add("usage-red");
    else if (pct >= 80) els.shiftUsageFill.classList.add("usage-amber");
  }

  function fmtHM(mins) {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h + "h " + m + "m";
  }

  function onEntryInputsChanged() {
    const thisMin = computeDurationMinutes(els.changeStart.value, els.changeEnd.value);
    const capacity = getSelectedMachineCapacity();

    if (thisMin > 0) {
      els.capacityWarning.classList.toggle("hidden", !!capacity);
      const scheduled = Math.round(thisMin * capacity);
      els.scheduledPreviewQty.textContent = String(scheduled);
      els.scheduledPreview.classList.remove("hidden");
      updateAchievement(scheduled);
    } else {
      els.scheduledPreview.classList.add("hidden");
      els.capacityWarning.classList.add("hidden");
      els.achievementBadge.classList.add("hidden");
    }
    renderShiftUsage();
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
    const machines = getDeptMachines(dept);
    els.machinesList.innerHTML = "";
    if (!machines.length) {
      els.machinesList.innerHTML = '<div class="settings-empty">No machines in this department yet.</div>';
      return;
    }
    machines.forEach((m) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      row.innerHTML =
        '<div><div class="settings-row-title">' + escapeHtml(m.machine) + '</div>' +
        '<div class="settings-row-sub">' + (m.capacityPerMin || 0) + ' / min</div></div>' +
        '<div class="settings-row-actions">' +
        '<button type="button" class="link-btn" data-editcap="' + escapeHtml(m.machine) + '">Edit capacity</button>' +
        '<button type="button" class="remove-x" data-remove="' + escapeHtml(m.machine) + '" aria-label="Remove">×</button>' +
        '</div>';
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
    els.machinesList.querySelectorAll("[data-editcap]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const current = machines.find((x) => x.machine === btn.dataset.editcap);
        const newVal = prompt("New capacity per minute for " + btn.dataset.editcap + ":", current ? current.capacityPerMin : 0);
        if (newVal === null) return;
        const num = Number(newVal);
        if (isNaN(num) || num < 0) {
          showToast("Enter a valid number");
          return;
        }
        const data = await adminPost("updateMachineCapacity", { department: dept, machine: btn.dataset.editcap, capacityPerMin: num });
        if (data.status === "ok") {
          showToast("Capacity updated");
          await loadServerConfig(true);
          refreshMachinesList();
        } else {
          showToast(data.message || "Could not update");
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
    const st = (SERVER_CONFIG && SERVER_CONFIG.shiftTimes) || {};
    els.dayShiftStartInput.value = (st.Day && st.Day.start) || "09:00";
    els.dayShiftEndInput.value = (st.Day && st.Day.end) || "17:30";
    els.nightShiftStartInput.value = (st.Night && st.Night.start) || "17:30";
    els.nightShiftEndInput.value = (st.Night && st.Night.end) || "09:00";
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

  function updateAchievement(scheduledQty) {
    const prod = parseFloat(els.producedQty.value);
    if (isNaN(prod) || !scheduledQty) {
      els.achievementBadge.classList.add("hidden");
      return;
    }
    const pct = Math.round((prod / scheduledQty) * 100);
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
    const rejectedMsgs = [];
    for (const entry of q) {
      const result = await sendToServer(entry);
      if (result.ok) continue;
      if (result.rejected) {
        rejectedMsgs.push((entry.machine || "") + " " + (entry.shift || "") + ": " + (result.message || "rejected"));
        continue; // don't keep retrying something the server actively refused
      }
      remaining.push(entry); // network problem — retry later
    }
    setQueue(remaining);
    if (rejectedMsgs.length) {
      showToast(rejectedMsgs.length + " queued entr" + (rejectedMsgs.length === 1 ? "y" : "ies") + " couldn't be saved: " + rejectedMsgs[0]);
    } else if (remaining.length === 0 && q.length > 0) {
      showToast("Synced all queued entries");
    }
  }

  async function sendToServer(entry) {
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(entry),
      });
      if (!res.ok) return { ok: false, rejected: false };
      const data = await res.json();
      if (data && data.status === "ok") return { ok: true };
      return { ok: false, rejected: true, message: data && data.message };
    } catch (e) {
      return { ok: false, rejected: false };
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
    els.changeStart.value = "";
    els.changeEnd.value = "";
    els.producedQty.value = "";
    els.achievementBadge.classList.add("hidden");
    els.scheduledPreview.classList.add("hidden");
    els.capacityWarning.classList.add("hidden");
    els.reason.value = "";
    els.remarks.value = "";
    els.operatorName.value = "";
    renderShiftUsage();
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
    const capacity = Number(els.newMachineCapacity.value) || 0;
    if (!dept || !machine) {
      showToast("Pick a department and enter a machine name");
      return;
    }
    const data = await adminPost("addMachine", { department: dept, machine, capacityPerMin: capacity });
    if (data.status === "ok") {
      showToast("Machine added");
      els.newMachineInput.value = "";
      els.newMachineCapacity.value = "";
      await loadServerConfig(true);
      refreshMachinesList();
    } else {
      showToast(data.message || "Could not add");
    }
  });

  els.addDeptBtn.addEventListener("click", async () => {
    const dept = els.newDeptName.value.trim();
    const machine = els.newDeptMachine.value.trim();
    const capacity = Number(els.newDeptMachineCapacity.value) || 0;
    if (!dept || !machine) {
      showToast("Enter a department name and its first machine");
      return;
    }
    const data = await adminPost("addMachine", { department: dept, machine, capacityPerMin: capacity });
    if (data.status === "ok") {
      showToast("Department created");
      els.newDeptName.value = "";
      els.newDeptMachine.value = "";
      els.newDeptMachineCapacity.value = "";
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
      dayShiftStart: els.dayShiftStartInput.value,
      dayShiftEnd: els.dayShiftEndInput.value,
      nightShiftStart: els.nightShiftStartInput.value,
      nightShiftEnd: els.nightShiftEndInput.value,
    });
    if (data.status === "ok") {
      showToast("Settings saved");
      await loadServerConfig(true);
      populateStaticFields();
      refreshShiftUsage();
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

  els.machine.addEventListener("change", () => {
    refreshShiftUsage();
    onEntryInputsChanged();
  });
  els.shift.addEventListener("change", () => {
    refreshShiftUsage();
    onEntryInputsChanged();
  });
  els.changeStart.addEventListener("input", onEntryInputsChanged);
  els.changeEnd.addEventListener("input", onEntryInputsChanged);
  els.producedQty.addEventListener("input", onEntryInputsChanged);

  els.itemCodeInput.addEventListener("input", () => {
    renderItemResults(searchItems(els.itemCodeInput.value));
  });

  els.clearItem.addEventListener("click", clearItem);

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

    const thisMin = computeDurationMinutes(els.changeStart.value, els.changeEnd.value);
    if (thisMin <= 0) {
      showToast("Enter a valid start and end time for this schedule");
      return;
    }
    if (shiftUsage) {
      const projected = (shiftUsage.usedMinutes || 0) + thisMin;
      if (projected > (shiftUsage.totalMinutes || 0) + 0.5) {
        const remaining = Math.max(0, Math.round((shiftUsage.totalMinutes || 0) - (shiftUsage.usedMinutes || 0)));
        showToast("This exceeds the shift's remaining time (" + remaining + " min left). Adjust the times.");
        return;
      }
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
      producedQty: els.producedQty.value,
      reason: els.reason.value,
      remarks: els.remarks.value,
      partChangeStart: els.changeStart.value,
      partChangeEnd: els.changeEnd.value,
      operatorName: els.operatorName.value,
      supervisorName: session.name,
    };

    saveLast();

    if (navigator.onLine && CONFIG.APPS_SCRIPT_URL) {
      const result = await sendToServer(entry);
      if (result.rejected) {
        showToast(result.message || "Could not save — adjust the entry and try again");
        return; // keep the form as-is so they can fix it
      }
      if (result.ok) {
        showToast("Entry saved");
        resetEntryFields();
        refreshShiftUsage();
        return;
      }
    }

    // Network unreachable (not an active rejection) — queue for later.
    enqueue(entry);
    showToast(CONFIG.APPS_SCRIPT_URL ? "Saved offline — will sync" : "Saved locally (no server configured)");
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
