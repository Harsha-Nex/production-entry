(function () {
  "use strict";

  const QUEUE_KEY = "prodentry_queue_v1";
  const LAST_KEY = "prodentry_last_v1";
  const ITEMS_CACHE_KEY = "prodentry_items_cache_v1";
  const SESSION_KEY = "prodentry_session_v1";
  const CONFIG_CACHE_KEY = "prodentry_config_cache_v1";
  const RECENT_KEY = "prodentry_recent_v1";
  const RECENT_MAX = 15;

  let ITEMS = [];
  let SERVER_CONFIG = null; // { departments: {dept: [{machineId, displayName}]}, slotsAllowed: {dept: {Day, Night}}, reasons, sessionTimeoutHours, shiftTimes }
  let selectedItem = null;
  let session = null; // { name, department, loginAt }
  let currentPin = "";
  let loginMode = "supervisor"; // "supervisor" | "admin"
  let adminPin = null; // in-memory only, cleared when Settings closes
  let editingSupervisorPin = null;
  let editingEntryId = null; // set when editing a row loaded from Recent Entries
  let editingQtyType = null; // "Manual" | "Auto" | null -- which Rolling row editingEntryId belongs to
  let shiftUsage = null; // latest { usedMinutes, totalMinutes, capacityPerMin, ... } for current machine+shift+item+today

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
    producedQtyGroup: $("producedQtyGroup"),
    producedQty: $("producedQty"),
    rollingQtyGroup: $("rollingQtyGroup"),
    producedQtyManual: $("producedQtyManual"),
    producedQtyAuto: $("producedQtyAuto"),
    manualCapRateField: $("manualCapRateField"),
    manualCapRate: $("manualCapRate"),
    achievementBadge: $("achievementBadge"),
    reason: $("reason"),
    remarks: $("remarks"),
    operatorName: $("operatorName"),
    form: $("entryForm"),
    submitBtn: $("submitBtn"),
    cancelEditBtn: $("cancelEditBtn"),
    recentEntriesList: $("recentEntriesList"),
    toast: $("toast"),
    netPill: $("netPill"),
    pendingPill: $("pendingPill"),
    needsFixPill: $("needsFixPill"),
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
    saveGeneralBtn: $("saveGeneralBtn"),
    slotsDeptSelect: $("slotsDeptSelect"),
    daySlotsInput: $("daySlotsInput"),
    nightSlotsInput: $("nightSlotsInput"),
    updateSlotsBtn: $("updateSlotsBtn"),
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
        SERVER_CONFIG = { departments: {}, slotsAllowed: {}, reasons: [], sessionTimeoutHours: 12, shiftTimes: {} };
      }
    }
  }

  function populateStaticFields() {
    fillSelect(els.shift, ["Day", "Night"], null);

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

  // Schedule slots are per-department AND per-shift now (Day/Night can differ).
  function refreshScheduleSlots(dept, shift) {
    const slots = [];
    const cfg = (SERVER_CONFIG && SERVER_CONFIG.slotsAllowed && SERVER_CONFIG.slotsAllowed[dept]) || { Day: 2, Night: 2 };
    const maxSlots = (String(shift).trim().toLowerCase() === "night" ? cfg.Night : cfg.Day) || 2;
    for (let i = 1; i <= maxSlots; i++) slots.push(String(i));
    fillSelect(els.scheduleSlot, slots, null);
  }

  function getDeptMachines(dept) {
    return (SERVER_CONFIG.departments && SERVER_CONFIG.departments[dept]) || [];
  }

  // Dropdown value is now the stable Machine ID; the label is the display name
  // supervisors actually recognize.
  function populateMachinesForDept(dept) {
    els.machine.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select machine";
    placeholder.disabled = true;
    placeholder.selected = true;
    els.machine.appendChild(placeholder);
    getDeptMachines(dept).forEach((m) => {
      const o = document.createElement("option");
      o.value = m.machineId;
      o.textContent = m.displayName;
      els.machine.appendChild(o);
    });
  }

  function machineDisplayName(machineId) {
    if (!session) return "";
    const found = getDeptMachines(session.department).find((m) => m.machineId === machineId);
    return found ? found.displayName : "";
  }

  // Rolling captures Manual and Auto quantities separately (E7); every other
  // department uses the single Produced Qty field.
  function updateQtyFieldsForDept(dept) {
    const isRolling = dept === "Rolling";
    els.producedQtyGroup.classList.toggle("hidden", isRolling);
    els.rollingQtyGroup.classList.toggle("hidden", !isRolling);
    els.producedQty.required = !isRolling;
    if (!isRolling) els.manualCapRateField.classList.add("hidden");
  }

  function currentProducedQty() {
    if (session && session.department === "Rolling") {
      const manual = parseFloat(els.producedQtyManual.value) || 0;
      const auto = parseFloat(els.producedQtyAuto.value) || 0;
      return manual + auto;
    }
    return parseFloat(els.producedQty.value) || 0;
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
    updateQtyFieldsForDept(s.department);
    applyLast(); // restores last machine/shift before slots are computed for that shift
    refreshScheduleSlots(s.department, els.shift.value);
    renderRecentEntries();
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
        const epoch = await fetchSessionEpoch();
        saveSession({ name: data.name, department: data.department, loginAt: Date.now(), sessionEpoch: epoch });
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

  // ---------- Session epoch (force-logout when an admin updates settings) ----------

  async function fetchSessionEpoch() {
    if (!CONFIG.APPS_SCRIPT_URL || !navigator.onLine) return 0;
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "checkSessionEpoch", secretToken: CONFIG.SECRET_TOKEN }),
      });
      const data = await res.json();
      return (data && data.status === "ok") ? (data.sessionEpoch || 0) : 0;
    } catch (e) {
      return 0;
    }
  }

  // Polls every 60s. A failed/offline check returns 0 and is ignored -- retried
  // next cycle. The first successful check after login just adopts the epoch as
  // a baseline (no logout); only a later mismatch against that baseline logs out.
  function checkSessionEpochLoop() {
    setInterval(async () => {
      if (!session || !navigator.onLine) return;
      const epoch = await fetchSessionEpoch();
      if (!epoch) return;
      if (!session.sessionEpoch) {
        session.sessionEpoch = epoch;
        saveSession(session);
        return;
      }
      if (epoch !== session.sessionEpoch) {
        clearSession();
        openLoginScreen("supervisor", "Settings updated — please log in again.");
      }
    }, 60000);
  }

  // ---------- Shift usage (time-based capacity) ----------
  // Rate resolution can depend on the selected item (Item Capacity Override),
  // so usage is re-fetched on machine, shift, AND item changes.

  async function fetchShiftUsage(machineId, shift, itemCode) {
    if (!CONFIG.APPS_SCRIPT_URL || !navigator.onLine || !machineId || !shift) return null;
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "getShiftUsage", secretToken: CONFIG.SECRET_TOKEN,
          machineId: machineId, shift: shift, itemCode: itemCode || "", date: todayDateStr(),
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
    shiftUsage = await fetchShiftUsage(els.machine.value, els.shift.value, selectedItem ? selectedItem.code : "");
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
    const isRolling = session && session.department === "Rolling";

    if (thisMin <= 0) {
      els.scheduledPreview.classList.add("hidden");
      els.capacityWarning.classList.add("hidden");
      els.achievementBadge.classList.add("hidden");
      renderShiftUsage();
      return;
    }

    if (isRolling) {
      const manualEntered = els.producedQtyManual.value !== "";
      const autoEntered = els.producedQtyAuto.value !== "";
      const manualRate = parseFloat(els.manualCapRate.value) || 0;
      const autoRate = shiftUsage ? (shiftUsage.capacityPerMin || 0) : 0;
      const manualScheduled = manualEntered ? Math.round(thisMin * manualRate) : 0;
      const autoScheduled = autoEntered ? Math.round(thisMin * autoRate) : 0;
      const totalScheduled = manualScheduled + autoScheduled;

      els.capacityWarning.classList.toggle("hidden", !(autoEntered && !autoRate));
      const parts = [];
      if (manualEntered) parts.push("Manual " + manualScheduled);
      if (autoEntered) parts.push("Auto " + autoScheduled);
      els.scheduledPreviewQty.textContent = String(totalScheduled) + (parts.length ? " (" + parts.join(" · ") + ")" : "");
      els.scheduledPreview.classList.remove("hidden");
      updateAchievement(totalScheduled);
    } else {
      const capacity = shiftUsage ? (shiftUsage.capacityPerMin || 0) : 0;
      els.capacityWarning.classList.toggle("hidden", !!capacity);
      const scheduled = Math.round(thisMin * capacity);
      els.scheduledPreviewQty.textContent = String(scheduled);
      els.scheduledPreview.classList.remove("hidden");
      updateAchievement(scheduled);
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
    populateSlotsDeptSelect();
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

  function populateSlotsDeptSelect() {
    fillSelect(els.slotsDeptSelect, Object.keys(SERVER_CONFIG.departments || {}), null);
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

  // Admin needs the full machine row (base rate, overrides, IsActive) which the
  // public config deliberately no longer carries -- fetched via listMachines.
  async function refreshMachinesList() {
    const dept = els.machDeptSelect.value;
    const data = await adminPost("listMachines", {});
    if (data.status !== "ok") {
      showToast(data.message || "Could not load machines");
      return;
    }
    const machines = data.machines.filter((m) => m.department === dept);
    els.machinesList.innerHTML = "";
    if (!machines.length) {
      els.machinesList.innerHTML = '<div class="settings-empty">No machines in this department yet.</div>';
      return;
    }
    machines.forEach((m) => {
      const row = document.createElement("div");
      row.className = "settings-row";
      row.innerHTML =
        '<div><div class="settings-row-title">' + escapeHtml(m.displayName) + (m.isActive ? "" : " (inactive)") + '</div>' +
        '<div class="settings-row-sub">' + (m.baseRate || 0) + ' / min · Slots — Day ' + m.daySlotsAllowed + ' / Night ' + m.nightSlotsAllowed + '</div></div>' +
        '<div class="settings-row-actions">' +
        '<button type="button" class="link-btn" data-editcap="' + escapeHtml(m.machineId) + '">Edit rate</button>' +
        '<button type="button" class="remove-x" data-remove="' + escapeHtml(m.machineId) + '" aria-label="Remove">×</button>' +
        '</div>';
      els.machinesList.appendChild(row);
    });
    els.machinesList.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove this machine?")) return;
        const data = await adminPost("removeMachine", { machineId: btn.dataset.remove });
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
        const current = machines.find((x) => x.machineId === btn.dataset.editcap);
        const newVal = prompt("New base rate (pcs/min) for " + (current ? current.displayName : "") + ":", current ? current.baseRate : 0);
        if (newVal === null) return;
        const num = Number(newVal);
        if (isNaN(num) || num < 0) {
          showToast("Enter a valid number");
          return;
        }
        const data = await adminPost("updateMachineCapacity", { machineId: btn.dataset.editcap, baseRate: num });
        if (data.status === "ok") {
          showToast("Rate updated");
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

  function renderItemResults(list, query) {
    els.itemResults.innerHTML = "";
    const trimmed = String(query || "").trim();
    const hasExactMatch = ITEMS.some((it) => String(it.code).toLowerCase() === trimmed.toLowerCase());
    const offerAdd = trimmed.length >= 2 && !hasExactMatch;

    if (!list.length && !offerAdd) {
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

    if (offerAdd) {
      const addRow = document.createElement("div");
      addRow.className = "item-row item-row-add";
      addRow.innerHTML =
        '<div class="item-code">+ Add "' + escapeHtml(trimmed) + '"</div>' +
        '<div class="item-name">New item code</div>';
      addRow.addEventListener("click", () => promptAddNewItem(trimmed));
      els.itemResults.appendChild(addRow);
    }
    els.itemResults.classList.remove("hidden");
  }

  // Frictionless by design: any supervisor can add a code they see on the
  // floor that isn't in the master list yet, no admin gate. Immediately
  // usable for this entry, and visible to other supervisors on their next
  // item-master refresh (on load, or online reconnect).
  async function promptAddNewItem(code) {
    if (!CONFIG.APPS_SCRIPT_URL || !navigator.onLine) {
      showToast("Connect to the internet to add a new item code");
      return;
    }
    const name = prompt('Item name for "' + code + '" (optional):', "") || "";
    try {
      const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "addItem", secretToken: CONFIG.SECRET_TOKEN, code: code, name: name }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        const newItem = { code: code, name: name };
        ITEMS.unshift(newItem);
        localStorage.setItem(ITEMS_CACHE_KEY, JSON.stringify(ITEMS));
        showToast("Item added");
        selectItem(newItem);
      } else {
        showToast(data.message || "Could not add item");
      }
    } catch (e) {
      showToast("Could not reach the server");
    }
  }

  function selectItem(it) {
    selectedItem = it;
    els.selectedItemCode.textContent = it.code;
    els.selectedItemName.textContent = it.name;
    els.selectedItem.classList.remove("hidden");
    els.itemCodeInput.value = "";
    els.itemCodeInput.classList.add("hidden");
    els.itemResults.classList.add("hidden");
    refreshShiftUsage(); // rate can depend on item code (Item Capacity Override)
  }

  function clearItem() {
    selectedItem = null;
    els.selectedItem.classList.add("hidden");
    els.itemCodeInput.classList.remove("hidden");
    els.itemCodeInput.value = "";
    els.itemCodeInput.focus();
    refreshShiftUsage();
  }

  // ---------- Achievement badge ----------

  function updateAchievement(scheduledQty) {
    const prod = currentProducedQty();
    if (!prod || !scheduledQty) {
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
    let rejectedCount = 0;
    for (const entry of q) {
      const result = await sendToServer(entry);
      if (result.ok) {
        markRecentSynced(entry.entryId);
        continue;
      }
      if (result.rejected) {
        // Route back to the supervisor's own Recent Entries list instead of
        // silently dropping it after a toast -- they have the floor context
        // to actually fix it; a background log doesn't.
        upsertRecent(entry, "Needs Fix", result.message);
        rejectedCount++;
        continue;
      }
      remaining.push(entry); // network problem — retry later
    }
    setQueue(remaining);
    if (rejectedCount) {
      showToast(rejectedCount + " entr" + (rejectedCount === 1 ? "y" : "ies") + " need" + (rejectedCount === 1 ? "s" : "") + " fixing — check Recent Entries");
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

  // ---------- Recent Entries (edit/resave + Needs Fix) ----------

  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function saveRecent(list) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  }

  function upsertRecent(entry, status, message) {
    const list = loadRecent();
    const idx = list.findIndex((e) => e.entryId === entry.entryId);
    const record = Object.assign({}, entry, { status: status, savedAt: Date.now(), rejectMessage: message || "" });
    if (idx >= 0) list[idx] = record; else list.unshift(record);
    saveRecent(list);
    renderRecentEntries();
  }

  function markRecentSynced(entryId) {
    const list = loadRecent();
    const idx = list.findIndex((e) => e.entryId === entryId);
    if (idx >= 0) {
      list[idx].status = "Synced";
      list[idx].rejectMessage = "";
      saveRecent(list);
      renderRecentEntries();
    }
  }

  function countNeedsFix() {
    return loadRecent().filter((e) => session && e.department === session.department && e.status === "Needs Fix").length;
  }

  function updateNeedsFixPill() {
    const count = countNeedsFix();
    if (count > 0) {
      els.needsFixPill.textContent = count + " need" + (count === 1 ? "s" : "") + " fixing";
      els.needsFixPill.classList.remove("hidden");
    } else {
      els.needsFixPill.classList.add("hidden");
    }
  }

  function renderRecentEntries() {
    if (!els.recentEntriesList) return;
    const list = loadRecent()
      .filter((e) => session && e.department === session.department)
      .sort((a, b) => (a.status === "Needs Fix" ? -1 : 0) - (b.status === "Needs Fix" ? -1 : 0));
    els.recentEntriesList.innerHTML = "";
    if (!list.length) {
      els.recentEntriesList.innerHTML = '<div class="settings-empty">No recent entries yet.</div>';
      updateNeedsFixPill();
      return;
    }
    list.forEach((e) => {
      const row = document.createElement("div");
      row.className = "recent-entry-row" + (e.status === "Needs Fix" ? " recent-entry-flagged" : "");
      const sub = e.status === "Needs Fix" && e.rejectMessage
        ? escapeHtml(e.rejectMessage)
        : escapeHtml(String(e.itemCode)) + " — Qty " + escapeHtml(String(e.producedQty || "")) + " · " + escapeHtml(e.status);
      row.innerHTML =
        '<div><div class="recent-entry-title">' + escapeHtml(machineDisplayName(e.machineId) || e.machineId) + " · " + escapeHtml(e.shift) + " · Slot " + escapeHtml(String(e.scheduleSlot)) +
        (e.qtyType ? " · " + escapeHtml(e.qtyType) : "") + '</div>' +
        '<div class="recent-entry-sub">' + sub + '</div></div>' +
        '<button type="button" class="link-btn" data-editentry="' + escapeHtml(e.entryId) + '">' + (e.status === "Needs Fix" ? "Fix" : "Edit") + '</button>';
      els.recentEntriesList.appendChild(row);
    });
    els.recentEntriesList.querySelectorAll("[data-editentry]").forEach((btn) => {
      btn.addEventListener("click", () => loadEntryForEdit(btn.dataset.editentry));
    });
    updateNeedsFixPill();
  }

  function loadEntryForEdit(entryId) {
    const entry = loadRecent().find((e) => e.entryId === entryId);
    if (!entry || !session) return;
    editingEntryId = entryId;
    editingQtyType = session.department === "Rolling" ? (entry.qtyType || null) : null;

    els.machine.value = entry.machineId;
    els.shift.value = entry.shift;
    refreshScheduleSlots(session.department, entry.shift);
    els.scheduleSlot.value = entry.scheduleSlot;

    const item = ITEMS.find((it) => String(it.code) === String(entry.itemCode));
    selectItem(item || { code: entry.itemCode, name: "" });

    els.changeStart.value = entry.scheduleStart || "";
    els.changeEnd.value = entry.scheduleEnd || "";

    if (session.department === "Rolling") {
      els.producedQtyManual.value = entry.qtyType === "Manual" ? (entry.producedQty || "") : "";
      els.producedQtyAuto.value = entry.qtyType === "Auto" ? (entry.producedQty || "") : "";
      els.manualCapRate.value = entry.qtyType === "Manual" ? (entry.manualCapRate || "") : "";
      els.manualCapRateField.classList.toggle("hidden", els.producedQtyManual.value === "");
    } else {
      els.producedQty.value = entry.producedQty || "";
    }

    els.reason.value = entry.reason || "";
    els.remarks.value = entry.remarks || "";
    els.operatorName.value = entry.operatorName || "";

    els.submitBtn.textContent = "Save changes";
    els.cancelEditBtn.classList.remove("hidden");
    onEntryInputsChanged();
  }

  function cancelEdit() {
    editingEntryId = null;
    editingQtyType = null;
    els.submitBtn.textContent = "Save entry";
    els.cancelEditBtn.classList.add("hidden");
    resetEntryFields();
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
    els.producedQtyManual.value = "";
    els.producedQtyAuto.value = "";
    els.manualCapRate.value = "";
    els.manualCapRateField.classList.add("hidden");
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
    const displayName = els.newMachineInput.value.trim();
    const baseRate = Number(els.newMachineCapacity.value) || 0;
    if (!dept || !displayName) {
      showToast("Pick a department and enter a machine name");
      return;
    }
    const data = await adminPost("addMachine", { department: dept, displayName, baseRate });
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
    const displayName = els.newDeptMachine.value.trim();
    const baseRate = Number(els.newDeptMachineCapacity.value) || 0;
    if (!dept || !displayName) {
      showToast("Enter a department name and its first machine");
      return;
    }
    const data = await adminPost("addMachine", { department: dept, displayName, baseRate });
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

  els.updateSlotsBtn.addEventListener("click", async () => {
    const dept = els.slotsDeptSelect.value;
    const daySlots = Number(els.daySlotsInput.value) || 0;
    const nightSlots = Number(els.nightSlotsInput.value) || 0;
    if (!dept || daySlots < 1 || nightSlots < 1) {
      showToast("Pick a department and enter Day/Night slots (1 or more)");
      return;
    }
    const data = await adminPost("updateDepartmentSlots", { department: dept, daySlots: daySlots, nightSlots: nightSlots });
    if (data.status === "ok") {
      showToast("Slots updated for " + data.updated + " machine" + (data.updated === 1 ? "" : "s") + " in " + dept);
      if (session) {
        session.sessionEpoch = data.sessionEpoch;
        saveSession(session);
      }
      await loadServerConfig(true);
    } else {
      showToast(data.message || "Could not update slots");
    }
  });

  // ---------- Event wiring: entry form ----------

  els.machine.addEventListener("change", () => {
    refreshShiftUsage();
    onEntryInputsChanged();
  });
  els.shift.addEventListener("change", () => {
    refreshScheduleSlots(session.department, els.shift.value);
    refreshShiftUsage();
    onEntryInputsChanged();
  });
  els.changeStart.addEventListener("input", onEntryInputsChanged);
  els.changeEnd.addEventListener("input", onEntryInputsChanged);
  els.producedQty.addEventListener("input", onEntryInputsChanged);
  els.producedQtyManual.addEventListener("input", () => {
    els.manualCapRateField.classList.toggle("hidden", els.producedQtyManual.value === "");
    onEntryInputsChanged();
  });
  els.producedQtyAuto.addEventListener("input", onEntryInputsChanged);
  els.manualCapRate.addEventListener("input", onEntryInputsChanged);

  els.itemCodeInput.addEventListener("input", () => {
    renderItemResults(searchItems(els.itemCodeInput.value), els.itemCodeInput.value);
  });

  els.clearItem.addEventListener("click", clearItem);
  els.cancelEditBtn.addEventListener("click", cancelEdit);

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

    const isRolling = session.department === "Rolling";
    const baseFields = {
      clientTimestamp: new Date().toISOString(),
      secretToken: CONFIG.SECRET_TOKEN,
      department: session.department,
      machineId: els.machine.value,
      shift: els.shift.value,
      scheduleSlot: els.scheduleSlot.value,
      itemCode: selectedItem.code,
      reason: els.reason.value,
      remarks: els.remarks.value,
      scheduleStart: els.changeStart.value,
      scheduleEnd: els.changeEnd.value,
      operatorName: els.operatorName.value,
      supervisorName: session.name,
    };

    const entries = [];
    if (isRolling) {
      const manual = els.producedQtyManual.value;
      const auto = els.producedQtyAuto.value;
      if (manual === "" && auto === "") {
        showToast("Enter a Manual or Auto qty");
        return;
      }
      if (manual !== "") {
        const manualCapRate = els.manualCapRate.value;
        if (manualCapRate === "" || Number(manualCapRate) <= 0) {
          showToast("Enter a Manual capacity rate for this entry");
          return;
        }
        entries.push(Object.assign({}, baseFields, {
          entryId: (editingEntryId && editingQtyType === "Manual") ? editingEntryId : uuid(),
          qtyType: "Manual", producedQty: manual, manualCapRate: manualCapRate,
        }));
      }
      if (auto !== "") {
        entries.push(Object.assign({}, baseFields, {
          entryId: (editingEntryId && editingQtyType === "Auto") ? editingEntryId : uuid(),
          qtyType: "Auto", producedQty: auto,
        }));
      }
    } else {
      entries.push(Object.assign({}, baseFields, {
        entryId: editingEntryId || uuid(),
        qtyType: "", producedQty: els.producedQty.value,
      }));
    }

    saveLast();
    const wasEditing = !!editingEntryId;

    for (const entry of entries) {
      if (navigator.onLine && CONFIG.APPS_SCRIPT_URL) {
        const result = await sendToServer(entry);
        if (result.rejected) {
          showToast(result.message || "Could not save — adjust the entry and try again");
          return; // keep the form as-is so they can fix it
        }
        if (result.ok) {
          upsertRecent(entry, "Synced");
          continue;
        }
      }
      // Network unreachable (not an active rejection) — queue for later.
      enqueue(entry);
      upsertRecent(entry, "Queued");
    }

    editingEntryId = null;
    editingQtyType = null;
    els.submitBtn.textContent = "Save entry";
    els.cancelEditBtn.classList.add("hidden");
    showToast(wasEditing ? "Entry updated" : "Entry saved");
    resetEntryFields();
    refreshShiftUsage();
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
    checkSessionEpochLoop();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    setInterval(flushQueue, 20000);
    flushQueue();
  }

  init();
})();
