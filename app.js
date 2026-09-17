(() => {
  "use strict";

  const SUPABASE_URL = "https://expaquvzlcuqrkrflxfo.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_snWcGgBjXbxl2Huhwj_oFg__XJNhc4G";
  const ORDERS_TABLE = "orders";
  const SESSION_KEY = "mediroute_session_v1";
  const REFRESH_INTERVAL_MS = 8000;
  const REPORT_WINDOW_HOURS = 24;
  const REPORT_WINDOW_MS = REPORT_WINDOW_HOURS * 60 * 60 * 1000;

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    throw new Error("Supabase library failed to load.");
  }

  const supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );

  const rooms = [
    "ICU 1",
    "ICU 2",
    "ICU 3",
    "Normal Ward 1",
    "Normal Ward 2",
    "OP Room",
    "Emergency Room",
    "Operation Theatre"
  ];

  const wardAccounts = {
    icu1: { password: "1234", room: "ICU 1" },
    icu2: { password: "1234", room: "ICU 2" },
    icu3: { password: "1234", room: "ICU 3" },
    normal1: { password: "1234", room: "Normal Ward 1" },
    normal2: { password: "1234", room: "Normal Ward 2" },
    oproom: { password: "1234", room: "OP Room" },
    emergency: { password: "1234", room: "Emergency Room" },
    operation: { password: "1234", room: "Operation Theatre" }
  };

  const statusSequence = ["Pending", "Accepted", "Packing", "Dispatched", "Delivered"];
  const statusMessages = {
    Pending: "Request sent. Waiting for the medication room to accept it.",
    Accepted: "The medication room has accepted your request.",
    Packing: "Your medicines are being collected and packed.",
    Dispatched: "Medicine is out for delivery by the hospital robot.",
    Delivered: "Delivery completed. Please confirm the medicine at your room."
  };

  let selectedLoginRole = null;
  let currentSession = readSession();
  let selectedOrderId = null;
  let currentOrderFilter = "active";
  let roomFilter = null;
  let ordersCache = [];
  let realtimeChannel = null;
  let refreshTimer = null;
  let databaseConnected = false;
  let initialOrdersLoaded = false;
  let audioContext = null;
  let soundUnlocked = false;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const elements = {
    homeView: $("#homeView"),
    medicationView: $("#medicationView"),
    wardView: $("#wardView"),
    logoutButton: $("#logoutButton"),
    loginModal: $("#loginModal"),
    loginForm: $("#loginForm"),
    closeLogin: $("#closeLogin"),
    loginTitle: $("#loginTitle"),
    loginDescription: $("#loginDescription"),
    loginIcon: $("#loginIcon"),
    usernameInput: $("#usernameInput"),
    passwordInput: $("#passwordInput"),
    loginError: $("#loginError"),
    medicationStats: $("#medicationStats"),
    roomGrid: $("#roomGrid"),
    orderList: $("#orderList"),
    pendingBadge: $("#pendingBadge"),
    orderFilters: $("#orderFilters"),
    requestForm: $("#requestForm"),
    medicineRows: $("#medicineRows"),
    addMedicineButton: $("#addMedicineButton"),
    notesInput: $("#notesInput"),
    wardTitle: $("#wardTitle"),
    wardUserLabel: $("#wardUserLabel"),
    wardOrderList: $("#wardOrderList"),
    requestPreview: $("#requestPreview"),
    resetDeliveryButton: $("#resetDeliveryButton"),
    medicationExportButton: $("#medicationExportButton"),
    wardExportButton: $("#wardExportButton"),
    clearDeliveredButton: $("#clearDeliveredButton"),
    orderModal: $("#orderModal"),
    closeOrderModal: $("#closeOrderModal"),
    orderModalBody: $("#orderModalBody"),
    toastContainer: $("#toastContainer"),
    connectionChip: $("#connectionChip")
  };

  function createId() {
    const now = new Date();
    const datePart = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const randomArray = new Uint32Array(1);
    crypto.getRandomValues(randomArray);
    const random = String(randomArray[0] % 1000000).padStart(6, "0");
    return `MR-${datePart}-${random}`;
  }

  function normaliseOrder(row) {
    return {
      id: row.id,
      room: row.room,
      items: Array.isArray(row.items) ? row.items : [],
      medicine: row.medicine || "Medicine",
      quantity: row.quantity || 1,
      unit: row.unit || "Units",
      priority: row.priority || "Normal",
      notes: row.notes || "",
      status: row.status || "Pending",
      createdAt: row.created_at || row.createdAt || new Date().toISOString(),
      updatedAt: row.updated_at || row.updatedAt || row.created_at || new Date().toISOString(),
      history: Array.isArray(row.history) ? row.history : []
    };
  }

  function orderToDatabase(order) {
    return {
      id: order.id,
      room: order.room,
      items: order.items || [],
      medicine: order.medicine || "Medicine",
      quantity: Number(order.quantity) || 1,
      unit: order.unit || "Units",
      priority: order.priority || "Normal",
      notes: order.notes || "",
      status: order.status || "Pending",
      created_at: order.createdAt,
      updated_at: order.updatedAt,
      history: order.history || []
    };
  }

  function getOrders() {
    return [...ordersCache];
  }

  function setConnectionState(state, message) {
    databaseConnected = state === "online";
    if (!elements.connectionChip) return;
    elements.connectionChip.classList.toggle("offline", state === "offline");
    elements.connectionChip.classList.toggle("connecting", state === "connecting");
    elements.connectionChip.innerHTML = `<i></i> ${escapeHtml(message)}`;
  }

  function showDatabaseError(error, action = "connect to the database") {
    console.error(`Unable to ${action}:`, error);
    setConnectionState("offline", "Database offline");
    const detail = error?.message || "Check the Supabase table and access policies.";
    toast("Database connection failed", detail, "error");
  }

  async function loadOrders({ silent = false } = {}) {
    try {
      const { data, error } = await supabaseClient
        .from(ORDERS_TABLE)
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      const previousOrders = ordersCache;
      const nextOrders = (data || []).map(normaliseOrder);
      ordersCache = nextOrders;
      setConnectionState("online", "Database Online");
      renderCurrentDashboard();
      handleOrderChanges(previousOrders, nextOrders);
      initialOrdersLoaded = true;
      return true;
    } catch (error) {
      if (!silent) showDatabaseError(error, "load medication orders");
      else setConnectionState("offline", "Database reconnecting");
      return false;
    }
  }

  async function insertOrder(order) {
    const { error } = await supabaseClient
      .from(ORDERS_TABLE)
      .insert(orderToDatabase(order));
    if (error) throw error;
    await loadOrders({ silent: true });
  }

  async function updateOrder(orderId, changes) {
    const databaseChanges = {};
    if (Object.hasOwn(changes, "status")) databaseChanges.status = changes.status;
    if (Object.hasOwn(changes, "updatedAt")) databaseChanges.updated_at = changes.updatedAt;
    if (Object.hasOwn(changes, "history")) databaseChanges.history = changes.history;

    const { error } = await supabaseClient
      .from(ORDERS_TABLE)
      .update(databaseChanges)
      .eq("id", orderId);
    if (error) throw error;
    await loadOrders({ silent: true });
  }

  async function deleteOrdersByStatuses(statuses) {
    const { error } = await supabaseClient
      .from(ORDERS_TABLE)
      .delete()
      .in("status", statuses);
    if (error) throw error;
    await loadOrders({ silent: true });
  }

  async function deleteDeliveredOrdersForRoom(room) {
    const { error } = await supabaseClient
      .from(ORDERS_TABLE)
      .delete()
      .eq("room", room)
      .eq("status", "Delivered");
    if (error) throw error;
    await loadOrders({ silent: true });
  }

  function subscribeToOrders() {
    if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

    realtimeChannel = supabaseClient
      .channel("mediroute-orders-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: ORDERS_TABLE },
        async () => {
          await loadOrders({ silent: true });
        }
      )
      .subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          setConnectionState("online", "Database Online");
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          setConnectionState("offline", "Database reconnecting");
          if (error) console.error("Supabase Realtime error:", error);
        }
      });
  }

  function startRefreshFallback() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => loadOrders({ silent: true }), REFRESH_INTERVAL_MS);
  }

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    currentSession = session;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    currentSession = null;
    sessionStorage.removeItem(SESSION_KEY);
  }

  function showView(viewName) {
    $$(".view").forEach((view) => view.classList.remove("active"));
    const target = viewName === "medication" ? elements.medicationView : viewName === "ward" ? elements.wardView : elements.homeView;
    target.classList.add("active");
    elements.logoutButton.classList.toggle("hidden", viewName === "home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openLogin(role) {
    selectedLoginRole = role;
    elements.loginError.classList.add("hidden");
    elements.loginForm.reset();

    if (role === "medication") {
      elements.loginTitle.textContent = "Medication Room Login";
      elements.loginDescription.textContent = "Access incoming ward requests and robot dispatch controls.";
      elements.loginIcon.textContent = "Rx";
    } else {
      elements.loginTitle.textContent = "Ward / ICU Login";
      elements.loginDescription.textContent = "Log in with the username assigned to your hospital room.";
      elements.loginIcon.textContent = "ICU";
    }

    elements.loginModal.classList.remove("hidden");
    setTimeout(() => elements.usernameInput.focus(), 50);
  }

  function closeLogin() {
    elements.loginModal.classList.add("hidden");
    selectedLoginRole = null;
  }

  function normaliseUsername(value) {
    return value.toLowerCase().replace(/[\s_-]+/g, "").trim();
  }

  function handleLogin(event) {
    event.preventDefault();
    const username = normaliseUsername(elements.usernameInput.value);
    const password = elements.passwordInput.value;
    let session = null;

    if (selectedLoginRole === "medication" && username === "medroom" && password === "med123") {
      session = { role: "medication", username: "medroom" };
    } else if (selectedLoginRole === "ward" && wardAccounts[username] && wardAccounts[username].password === password) {
      session = { role: "ward", username, room: wardAccounts[username].room };
    }

    if (!session) {
      elements.loginError.classList.remove("hidden");
      elements.passwordInput.select();
      return;
    }

    saveSession(session);
    closeLogin();
    routeSession();
    toast("Login successful", session.role === "medication" ? "Medication room dashboard opened." : `${session.room} is connected.`, "success");
  }

  function routeSession() {
    if (!currentSession) {
      showView("home");
      return;
    }

    if (currentSession.role === "medication") {
      showView("medication");
      renderMedicationDashboard();
    } else {
      elements.wardTitle.textContent = `${currentSession.room} Dashboard`;
      elements.wardUserLabel.textContent = `${currentSession.room} connected`;
      elements.requestPreview.textContent = createId();
      showView("ward");
      renderWardDashboard();
    }
  }

  function statusClass(status) {
    return `status-${status.toLowerCase()}`;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  }

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }


  function priorityRank(priority) {
    return { Emergency: 0, Urgent: 1, Normal: 2 }[priority] ?? 3;
  }

  function comparePriorityThenNewest(a, b) {
    const priorityDifference = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDifference !== 0) return priorityDifference;
    return new Date(b.createdAt) - new Date(a.createdAt);
  }

  function priorityCssClass(priority) {
    return `priority-${String(priority || "Normal").toLowerCase()}`;
  }

  function unlockSound() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioContext) audioContext = new AudioContextClass();
      if (audioContext.state === "suspended") audioContext.resume();
      soundUnlocked = true;
    } catch (error) {
      console.warn("Audio could not be enabled:", error);
    }
  }

  function playTone(frequency, startDelay, duration, volume = 0.075, wave = "sine") {
    if (!soundUnlocked || !audioContext) return;
    const startTime = audioContext.currentTime + startDelay;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, startTime);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.025);
  }

  function playWorkflowSound(eventName, priority = "Normal") {
    unlockSound();
    if (!soundUnlocked || !audioContext) return;

    const patterns = {
      "request-sent": [[660, 0, .11], [880, .13, .17]],
      Accepted: [[523, 0, .12], [659, .14, .16]],
      Packing: [[440, 0, .10], [554, .12, .10], [659, .24, .14]],
      Dispatched: [[659, 0, .11], [784, .12, .11], [988, .24, .18]],
      Delivered: [[784, 0, .12], [988, .13, .12], [1175, .26, .20]],
      export: [[587, 0, .10], [784, .12, .15]],
      clear: [[392, 0, .12], [330, .14, .18]]
    };

    let pattern = patterns[eventName];
    if (eventName === "new-order") {
      if (priority === "Emergency") {
        pattern = [[920, 0, .13], [690, .16, .13], [920, .32, .13], [690, .48, .13], [1040, .64, .20]];
      } else if (priority === "Urgent") {
        pattern = [[720, 0, .13], [720, .18, .13], [880, .36, .17]];
      } else {
        pattern = [[560, 0, .12], [720, .14, .17]];
      }
    }

    (pattern || []).forEach(([frequency, delay, duration], index) => {
      playTone(frequency, delay, duration, eventName === "new-order" && priority === "Emergency" ? 0.105 : 0.075, index % 2 ? "triangle" : "sine");
    });
  }

  function handleOrderChanges(previousOrders, nextOrders) {
    if (!initialOrdersLoaded || !currentSession) return;

    const previousById = new Map(previousOrders.map((order) => [order.id, order]));
    const newOrders = nextOrders.filter((order) => !previousById.has(order.id));
    const statusChanges = nextOrders.filter((order) => {
      const previous = previousById.get(order.id);
      return previous && previous.status !== order.status;
    });

    if (currentSession.role === "medication") {
      if (newOrders.length) {
        const sortedNewOrders = [...newOrders].sort(comparePriorityThenNewest);
        const highestPriorityOrder = sortedNewOrders[0];
        playWorkflowSound("new-order", highestPriorityOrder.priority);
        const title = highestPriorityOrder.priority === "Emergency"
          ? "Emergency order received"
          : highestPriorityOrder.priority === "Urgent"
            ? "Urgent order received"
            : "New medication order";
        const additional = newOrders.length > 1 ? ` +${newOrders.length - 1} more new order${newOrders.length > 2 ? "s" : ""}.` : "";
        toast(title, `${highestPriorityOrder.room}: ${medicineTitle(highestPriorityOrder)}.${additional}`, highestPriorityOrder.priority === "Emergency" ? "error" : "success");
      }

      if (statusChanges.length) {
        const latestChange = [...statusChanges].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
        playWorkflowSound(latestChange.status, latestChange.priority);
      }
      return;
    }

    const roomStatusChanges = statusChanges
      .filter((order) => order.room === currentSession.room)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    if (roomStatusChanges.length) {
      const latestChange = roomStatusChanges[0];
      playWorkflowSound(latestChange.status, latestChange.priority);
      toast(latestChange.status, statusMessages[latestChange.status] || "The medication order status changed.", "success");
    }
  }

  function dateForReport(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-IN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date);
  }

  function reportActivityTime(order) {
    const created = new Date(order.createdAt).getTime() || 0;
    const updated = new Date(order.updatedAt).getTime() || 0;
    return Math.max(created, updated);
  }

  function safeSpreadsheetText(value = "") {
    const text = String(value);
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  }

  function lastHistoryTime(order, status) {
    const entries = (order.history || []).filter((item) => item.status === status);
    if (!entries.length) return "";
    return dateForReport(entries[entries.length - 1].time);
  }

  function reportRowsFromOrders(orders) {
    return orders.flatMap((order) => getOrderItems(order).map((item, index) => ({
      "Order ID": safeSpreadsheetText(order.id),
      "Room / Department": safeSpreadsheetText(order.room),
      "Priority": order.priority,
      "Current Status": order.status,
      "Medicine Item No.": index + 1,
      "Medicine": safeSpreadsheetText(item.medicine),
      "Quantity": Number(item.quantity) || 0,
      "Unit": safeSpreadsheetText(item.unit),
      "Notes": safeSpreadsheetText(order.notes || ""),
      "Requested At": dateForReport(order.createdAt),
      "Last Updated": dateForReport(order.updatedAt),
      "Accepted At": lastHistoryTime(order, "Accepted"),
      "Packing At": lastHistoryTime(order, "Packing"),
      "Dispatched At": lastHistoryTime(order, "Dispatched"),
      "Delivered At": lastHistoryTime(order, "Delivered")
    })));
  }

  function downloadCsvFallback(rows, filename) {
    const headers = Object.keys(rows[0] || { Message: "No data" });
    const values = rows.length ? rows : [{ Message: "No order activity during the last 24 hours." }];
    const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [headers, ...values.map((row) => headers.map((header) => row[header] ?? ""))]
      .map((row) => row.map(escapeCsv).join(","))
      .join("\r\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename.replace(/\.xlsx$/i, ".csv");
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  function exportLast24Hours({ room = null, sourceOrders = null, purpose = "Manual export" } = {}) {
    const cutoff = Date.now() - REPORT_WINDOW_MS;
    const scopeOrders = (sourceOrders || getOrders())
      .filter((order) => !room || order.room === room)
      .filter((order) => reportActivityTime(order) >= cutoff)
      .sort(comparePriorityThenNewest);

    if (!scopeOrders.length) {
      toast("No 24-hour data", room ? `No ${room} order activity was found in the last 24 hours.` : "No hospital order activity was found in the last 24 hours.");
      return 0;
    }

    const scopeName = room || "All Hospital Rooms";
    const reportRows = reportRowsFromOrders(scopeOrders);
    const uniqueOrders = new Set(scopeOrders.map((order) => order.id)).size;
    const summaryRows = [
      ["MediRoute 24-Hour Medication Order Report"],
      ["Scope", scopeName],
      ["Purpose", purpose],
      ["Report generated", dateForReport(new Date().toISOString())],
      ["Period start", dateForReport(new Date(cutoff).toISOString())],
      ["Period end", dateForReport(new Date().toISOString())],
      ["Total orders", uniqueOrders],
      ["Emergency", scopeOrders.filter((order) => order.priority === "Emergency").length],
      ["Urgent", scopeOrders.filter((order) => order.priority === "Urgent").length],
      ["Normal", scopeOrders.filter((order) => order.priority === "Normal").length],
      ["Pending", scopeOrders.filter((order) => order.status === "Pending").length],
      ["Accepted", scopeOrders.filter((order) => order.status === "Accepted").length],
      ["Packing", scopeOrders.filter((order) => order.status === "Packing").length],
      ["Dispatched", scopeOrders.filter((order) => order.status === "Dispatched").length],
      ["Delivered", scopeOrders.filter((order) => order.status === "Delivered").length]
    ];

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replaceAll(":", "-");
    const safeScope = scopeName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    const filename = `MediRoute_${safeScope}_24h_${timestamp}.xlsx`;

    if (!window.XLSX) {
      downloadCsvFallback(reportRows, filename);
      toast("Excel fallback created", "The spreadsheet library was unavailable, so a CSV file compatible with Excel was downloaded.", "success");
      playWorkflowSound("export");
      return uniqueOrders;
    }

    const workbook = XLSX.utils.book_new();
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    summarySheet["!cols"] = [{ wch: 24 }, { wch: 38 }];

    const orderSheet = XLSX.utils.json_to_sheet(reportRows);
    orderSheet["!cols"] = [
      { wch: 19 }, { wch: 23 }, { wch: 12 }, { wch: 15 }, { wch: 17 },
      { wch: 30 }, { wch: 11 }, { wch: 12 }, { wch: 38 }, { wch: 23 },
      { wch: 23 }, { wch: 23 }, { wch: 23 }, { wch: 23 }, { wch: 23 }
    ];
    orderSheet["!autofilter"] = { ref: orderSheet["!ref"] };

    XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");
    XLSX.utils.book_append_sheet(workbook, orderSheet, "Order Data");
    XLSX.writeFile(workbook, filename, { compression: true });

    toast("24-hour Excel created", `${uniqueOrders} order${uniqueOrders === 1 ? "" : "s"} exported for ${scopeName}.`, "success");
    playWorkflowSound("export");
    return uniqueOrders;
  }

  const medicineOptions = [
    "Paracetamol 500 mg",
    "Amoxicillin 500 mg",
    "Insulin Injection",
    "Saline 500 ml",
    "Adrenaline Injection",
    "Atropine Injection",
    "Heparin Injection",
    "Oxygen Mask",
    "Syringe 5 ml",
    "Bandage Roll"
  ];

  const medicineUnits = ["Tablets", "Boxes", "Bottles", "Vials", "Units", "Packs"];

  function getOrderItems(order) {
    if (Array.isArray(order.items) && order.items.length) return order.items;
    return [{
      medicine: order.medicine || "Medicine",
      quantity: order.quantity || 1,
      unit: order.unit || "Units"
    }];
  }

  function medicineTitle(order) {
    const items = getOrderItems(order);
    if (items.length === 1) return items[0].medicine;
    const names = items.slice(0, 2).map((item) => item.medicine).join(", ");
    return items.length > 2 ? `${names} +${items.length - 2} more` : names;
  }

  function medicineQuantitySummary(order) {
    const items = getOrderItems(order);
    if (items.length === 1) return `${items[0].quantity} ${items[0].unit}`;
    return `${items.length} medicine items`;
  }

  function medicineItemsMarkup(order) {
    return getOrderItems(order).map((item) => `
      <div class="detail-medicine-item">
        <strong>${escapeHtml(item.medicine)}</strong>
        <span>${escapeHtml(item.quantity)} ${escapeHtml(item.unit)}</span>
      </div>
    `).join("");
  }

  function createMedicineRow(values = {}) {
    const row = document.createElement("div");
    row.className = "medicine-row";
    row.innerHTML = `
      <label class="medicine-field">
        <span>Medicine</span>
        <select class="medicine-choice" required>
          <option value="">Select medicine</option>
          ${medicineOptions.map((medicine) => `<option value="${escapeHtml(medicine)}">${escapeHtml(medicine)}</option>`).join("")}
          <option value="Other">Other medicine</option>
        </select>
      </label>
      <label class="medicine-quantity-field">
        <span>Quantity</span>
        <input class="medicine-quantity" type="number" min="1" max="999" value="${escapeHtml(values.quantity || 1)}" required>
      </label>
      <label class="medicine-unit-field">
        <span>Unit</span>
        <select class="medicine-unit" required>
          ${medicineUnits.map((unit) => `<option value="${unit}">${unit}</option>`).join("")}
        </select>
      </label>
      <button class="remove-medicine-button" type="button" aria-label="Remove medicine">×</button>
      <label class="custom-medicine-field hidden">
        <span>Medicine name</span>
        <input class="custom-medicine-input" type="text" placeholder="Enter medicine name">
      </label>
    `;

    const select = row.querySelector(".medicine-choice");
    const unit = row.querySelector(".medicine-unit");
    const customField = row.querySelector(".custom-medicine-field");
    const customInput = row.querySelector(".custom-medicine-input");

    if (values.medicine && medicineOptions.includes(values.medicine)) {
      select.value = values.medicine;
    } else if (values.medicine) {
      select.value = "Other";
      customField.classList.remove("hidden");
      customInput.required = true;
      customInput.value = values.medicine;
    }
    if (values.unit && medicineUnits.includes(values.unit)) unit.value = values.unit;

    select.addEventListener("change", () => {
      const otherSelected = select.value === "Other";
      customField.classList.toggle("hidden", !otherSelected);
      customInput.required = otherSelected;
      if (!otherSelected) customInput.value = "";
    });

    row.querySelector(".remove-medicine-button").addEventListener("click", () => {
      const rows = elements.medicineRows.querySelectorAll(".medicine-row");
      if (rows.length === 1) {
        toast("At least one medicine required", "Keep one medicine row in the request.", "error");
        return;
      }
      row.remove();
      updateMedicineRowControls();
    });

    return row;
  }

  function updateMedicineRowControls() {
    const rows = [...elements.medicineRows.querySelectorAll(".medicine-row")];
    rows.forEach((row, index) => {
      const button = row.querySelector(".remove-medicine-button");
      button.disabled = rows.length === 1;
      row.dataset.itemNumber = String(index + 1);
    });
  }

  function addMedicineRow(values = {}) {
    elements.medicineRows.appendChild(createMedicineRow(values));
    updateMedicineRowControls();
  }

  function resetMedicineRows() {
    elements.medicineRows.innerHTML = "";
    addMedicineRow();
  }

  function collectMedicineItems() {
    const rows = [...elements.medicineRows.querySelectorAll(".medicine-row")];
    const items = [];

    for (const row of rows) {
      const select = row.querySelector(".medicine-choice");
      const custom = row.querySelector(".custom-medicine-input");
      const quantity = Number(row.querySelector(".medicine-quantity").value);
      const unit = row.querySelector(".medicine-unit").value;
      const medicine = select.value === "Other" ? custom.value.trim() : select.value;

      if (!medicine || !quantity || quantity < 1 || !unit) return null;
      items.push({ medicine, quantity, unit });
    }

    return items;
  }

  function renderMedicationDashboard() {
    const orders = getOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const pending = orders.filter((order) => order.status === "Pending").length;
    const preparing = orders.filter((order) => ["Accepted", "Packing"].includes(order.status)).length;
    const dispatched = orders.filter((order) => order.status === "Dispatched").length;
    const delivered = orders.filter((order) => order.status === "Delivered").length;

    elements.medicationStats.innerHTML = [
      ["Pending requests", pending, "!"],
      ["Preparing", preparing, "Rx"],
      ["Out for delivery", dispatched, "→"],
      ["Delivered", delivered, "✓"]
    ].map(([label, count, icon]) => `
      <article class="stat-card">
        <div><span>${label}</span><strong>${count}</strong></div>
        <div class="stat-icon">${icon}</div>
      </article>
    `).join("");

    elements.pendingBadge.textContent = `${pending} pending`;
    renderRoomCards(orders);
    renderMedicationOrders(orders);
  }

  function renderRoomCards(orders) {
    elements.roomGrid.innerHTML = rooms.map((room) => {
      const roomOrders = orders.filter((order) => order.room === room && order.status !== "Delivered");
      const hasPending = roomOrders.some((order) => order.status === "Pending");
      const hasDispatch = roomOrders.some((order) => order.status === "Dispatched");
      const hasProgress = roomOrders.some((order) => ["Accepted", "Packing"].includes(order.status));

      let stateClass = "";
      let stateText = "No active request";
      if (hasPending) { stateClass = "pending"; stateText = "New request received"; }
      else if (hasDispatch) { stateClass = "dispatch"; stateText = "Robot out for delivery"; }
      else if (hasProgress) { stateClass = "progress"; stateText = "Medicine being prepared"; }

      return `
        <article class="room-card" data-room-filter="${escapeHtml(room)}" title="Click to filter orders for ${escapeHtml(room)}">
          <div class="room-top">
            <span class="room-name">${escapeHtml(room)}</span>
            <span class="room-count">${roomOrders.length} active</span>
          </div>
          <div class="room-state ${stateClass}"><i></i>${stateText}</div>
        </article>
      `;
    }).join("");

    $$('[data-room-filter]').forEach((card) => {
      card.addEventListener("click", () => {
        const room = card.dataset.roomFilter;
        roomFilter = roomFilter === room ? null : room;
        toast(roomFilter ? `Showing ${roomFilter}` : "Room filter removed", roomFilter ? "Only this room's orders are displayed." : "All room orders are displayed.");
        renderMedicationOrders(getOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
      });
    });
  }

  function renderMedicationOrders(orders) {
    let filtered = [...orders];
    if (currentOrderFilter === "active") filtered = filtered.filter((order) => order.status !== "Delivered");
    if (currentOrderFilter === "delivered") filtered = filtered.filter((order) => order.status === "Delivered");
    if (roomFilter) filtered = filtered.filter((order) => order.room === roomFilter);
    filtered.sort(comparePriorityThenNewest);

    if (!filtered.length) {
      elements.orderList.innerHTML = `<div class="empty-state"><strong>No matching requests</strong><span>New ward orders will appear here automatically.</span></div>`;
      return;
    }

    elements.orderList.innerHTML = filtered.map((order) => `
      <article class="order-item ${priorityCssClass(order.priority)}" data-order-id="${order.id}">
        <div class="order-row">
          <div>
            <h3>${escapeHtml(medicineTitle(order))}</h3>
            <div class="order-meta"><b>${escapeHtml(order.room)}</b> · ${escapeHtml(medicineQuantitySummary(order))}<br>${escapeHtml(order.id)} · ${formatDate(order.createdAt)}</div>
          </div>
          <span class="status-badge ${statusClass(order.status)}">${order.status}</span>
        </div>
        <div class="tracking-footer">
          <span class="priority-light ${priorityCssClass(order.priority)}"><i></i>${escapeHtml(order.priority)} priority</span>
          <span class="tracking-time">Open details →</span>
        </div>
      </article>
    `).join("");

    $$('[data-order-id]').forEach((item) => item.addEventListener("click", () => openOrderModal(item.dataset.orderId)));
  }

  function renderWardDashboard() {
    if (!currentSession || currentSession.role !== "ward") return;
    const orders = getOrders()
      .filter((order) => order.room === currentSession.room)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (!orders.length) {
      elements.wardOrderList.innerHTML = `<div class="empty-state"><strong>No medication requests</strong><span>Your submitted orders and delivery status will appear here.</span></div>`;
      return;
    }

    elements.wardOrderList.innerHTML = orders.map((order) => {
      const progressIndex = statusSequence.indexOf(order.status);
      return `
        <article class="tracking-item">
          <div class="order-row">
            <div>
              <h3>${escapeHtml(medicineTitle(order))}</h3>
              <div class="order-meta">${escapeHtml(medicineQuantitySummary(order))} · ${escapeHtml(order.id)}<br>Requested ${formatDate(order.createdAt)}</div>
            </div>
            <span class="status-badge ${statusClass(order.status)}">${order.status}</span>
          </div>
          <div class="progress-steps" aria-label="Delivery progress">
            ${[1, 2, 3, 4].map((step) => `<span class="progress-step ${progressIndex >= step ? "done" : ""}"></span>`).join("")}
          </div>
          <div class="tracking-footer">
            <span class="tracking-message">${statusMessages[order.status]}</span>
            <span class="tracking-time">Updated ${formatDate(order.updatedAt)}</span>
          </div>
        </article>
      `;
    }).join("");
  }

  async function handleRequestSubmit(event) {
    event.preventDefault();
    if (!currentSession || currentSession.role !== "ward") return;

    const items = collectMedicineItems();
    if (!items) {
      toast("Complete medicine details", "Choose every medicine and enter a valid quantity.", "error");
      return;
    }

    const submitButton = elements.requestForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "Sending request...";

    const now = new Date().toISOString();
    const order = {
      id: createId(),
      room: currentSession.room,
      items,
      medicine: items.length === 1 ? items[0].medicine : `${items.length} medicines`,
      quantity: items.length === 1 ? items[0].quantity : items.length,
      unit: items.length === 1 ? items[0].unit : "items",
      priority: document.querySelector('input[name="priority"]:checked').value,
      notes: elements.notesInput.value.trim(),
      status: "Pending",
      createdAt: now,
      updatedAt: now,
      history: [{ status: "Pending", time: now }]
    };

    try {
      await insertOrder(order);
      elements.requestForm.reset();
      resetMedicineRows();
      elements.requestPreview.textContent = createId();
      playWorkflowSound("request-sent", order.priority);
      toast("Request sent", `${items.length} medicine${items.length === 1 ? "" : "s"} sent to the medication room.`, "success");
    } catch (error) {
      showDatabaseError(error, "send the medication request");
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = 'Send Request to Medication Room <span>→</span>';
    }
  }

  function openOrderModal(orderId) {
    const order = getOrders().find((item) => item.id === orderId);
    if (!order) return;
    selectedOrderId = orderId;
    const progressIndex = statusSequence.indexOf(order.status);
    const nextStatus = statusSequence[progressIndex + 1];
    const nextLabels = {
      Accepted: "Accept Order",
      Packing: "Start Packing",
      Dispatched: "Finish Packing & Dispatch Robot",
      Delivered: "Mark as Delivered"
    };

    elements.orderModalBody.innerHTML = `
      <div class="order-detail-top">
        <div>
          <span class="section-label">${escapeHtml(order.id)}</span>
          <h2 id="orderModalTitle">${escapeHtml(medicineTitle(order))}</h2>
          <div class="order-meta">Request from <b>${escapeHtml(order.room)}</b></div>
        </div>
        <span class="status-badge ${statusClass(order.status)}">${order.status}</span>
      </div>

      <div class="detail-grid">
        <div class="detail-box"><span>Room</span><strong>${escapeHtml(order.room)}</strong></div>
        <div class="detail-box"><span>Medicines</span><strong>${getOrderItems(order).length} item${getOrderItems(order).length === 1 ? "" : "s"}</strong></div>
        <div class="detail-box"><span>Priority</span><strong class="${order.priority === "Emergency" ? "priority-emergency" : order.priority === "Urgent" ? "priority-urgent" : ""}">${escapeHtml(order.priority)}</strong></div>
        <div class="detail-box"><span>Requested</span><strong>${formatDate(order.createdAt)}</strong></div>
      </div>

      <div class="detail-medicine-list">${medicineItemsMarkup(order)}</div>

      <div class="detail-note"><strong>Notes:</strong> ${order.notes ? escapeHtml(order.notes) : "No additional instructions."}</div>

      <div class="status-flow">
        ${statusSequence.map((status, index) => `
          <div class="flow-item ${index <= progressIndex ? "done" : ""}">
            <span class="flow-dot">${index <= progressIndex ? "✓" : index + 1}</span>
            <span>${status}${status === "Dispatched" ? " — robot out for delivery" : ""}</span>
          </div>
        `).join("")}
      </div>

      <div class="modal-actions">
        ${nextStatus ? `<button class="primary-button ${nextStatus === "Dispatched" || nextStatus === "Delivered" ? "success" : ""}" id="advanceOrderButton" type="button">${nextLabels[nextStatus]} <span>→</span></button>` : `<button class="primary-button secondary" type="button" disabled>Order completed ✓</button>`}
      </div>
    `;

    elements.orderModal.classList.remove("hidden");
    const advanceButton = $("#advanceOrderButton");
    if (advanceButton) advanceButton.addEventListener("click", advanceSelectedOrder);
  }

  function closeOrderModal() {
    elements.orderModal.classList.add("hidden");
    selectedOrderId = null;
  }

  async function advanceSelectedOrder() {
    const order = getOrders().find((item) => item.id === selectedOrderId);
    if (!order) return;
    const currentIndex = statusSequence.indexOf(order.status);
    if (currentIndex >= statusSequence.length - 1) return;

    const advanceButton = $("#advanceOrderButton");
    if (advanceButton) {
      advanceButton.disabled = true;
      advanceButton.textContent = "Updating...";
    }

    const nextStatus = statusSequence[currentIndex + 1];
    const now = new Date().toISOString();
    const history = [...(order.history || []), { status: nextStatus, time: now }];

    try {
      await updateOrder(order.id, { status: nextStatus, updatedAt: now, history });
      const messages = {
        Accepted: "The ward has been notified that the order was accepted.",
        Packing: "The ward can now see that medicines are being prepared.",
        Dispatched: "Green delivery status sent: medicine is out for delivery.",
        Delivered: "The delivery has been marked as completed."
      };
      toast(nextStatus, messages[nextStatus], "success");
      openOrderModal(selectedOrderId);
    } catch (error) {
      showDatabaseError(error, "update the order status");
      openOrderModal(selectedOrderId);
    }
  }


  function renderCurrentDashboard() {
    if (!currentSession) return;
    if (currentSession.role === "medication") renderMedicationDashboard();
    if (currentSession.role === "ward") renderWardDashboard();
  }

  function toast(title, message, type = "") {
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(message)}`;
    elements.toastContainer.appendChild(item);
    setTimeout(() => item.remove(), 4300);
  }

  function bindEvents() {
    $$('[data-role]').forEach((button) => button.addEventListener("click", () => openLogin(button.dataset.role)));
    $$('[data-action="go-home"]').forEach((button) => button.addEventListener("click", (event) => {
      event.preventDefault();
      if (currentSession) return;
      showView("home");
    }));

    elements.loginForm.addEventListener("submit", handleLogin);
    elements.closeLogin.addEventListener("click", closeLogin);
    elements.loginModal.addEventListener("click", (event) => { if (event.target === elements.loginModal) closeLogin(); });
    elements.logoutButton.addEventListener("click", () => {
      clearSession();
      roomFilter = null;
      showView("home");
      toast("Logged out", "The dashboard session has ended.");
    });

    elements.addMedicineButton.addEventListener("click", () => addMedicineRow());
    resetMedicineRows();

    elements.requestForm.addEventListener("submit", handleRequestSubmit);

    elements.medicationExportButton.addEventListener("click", () => {
      exportLast24Hours({ purpose: "Medication Room manual 24-hour report" });
    });

    elements.wardExportButton.addEventListener("click", () => {
      if (!currentSession || currentSession.role !== "ward") return;
      exportLast24Hours({ room: currentSession.room, purpose: `${currentSession.room} manual 24-hour report` });
    });

    elements.orderFilters.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      currentOrderFilter = button.dataset.filter;
      $$(".filter").forEach((item) => item.classList.toggle("active", item === button));
      renderMedicationDashboard();
    });

    elements.resetDeliveryButton.addEventListener("click", async () => {
      const resettableOrders = getOrders().filter((order) => ["Dispatched", "Delivered"].includes(order.status));

      if (!resettableOrders.length) {
        toast("Counts already reset", "Out for delivery and Delivered are already 0.");
        return;
      }

      const confirmed = window.confirm("Reset Out for delivery and Delivered counts to 0? A 24-hour Excel backup will download before these records are cleared from every device.");
      if (!confirmed) return;

      elements.resetDeliveryButton.disabled = true;
      try {
        exportLast24Hours({ sourceOrders: resettableOrders, purpose: "Automatic backup before delivery-count reset" });
        await deleteOrdersByStatuses(["Dispatched", "Delivered"]);
        toast("Delivery counts reset", "Out for delivery and Delivered are now 0 on every device.", "success");
      } catch (error) {
        showDatabaseError(error, "reset delivery counts");
      } finally {
        elements.resetDeliveryButton.disabled = false;
      }
    });

    elements.clearDeliveredButton.addEventListener("click", async () => {
      if (!currentSession || currentSession.role !== "ward") return;
      const deliveredOrders = getOrders().filter((order) => order.room === currentSession.room && order.status === "Delivered");
      if (!deliveredOrders.length) {
        toast("No delivered requests", "There are no delivered orders to clear for this room.");
        return;
      }

      const confirmed = window.confirm("Clear delivered requests? A 24-hour Excel backup will download before the records are removed.");
      if (!confirmed) return;

      elements.clearDeliveredButton.disabled = true;
      try {
        exportLast24Hours({ room: currentSession.room, sourceOrders: deliveredOrders, purpose: "Automatic backup before clearing delivered requests" });
        await deleteDeliveredOrdersForRoom(currentSession.room);
        playWorkflowSound("clear");
        toast("Delivered requests cleared", "Completed requests were removed from this room on every device.", "success");
      } catch (error) {
        showDatabaseError(error, "clear delivered requests");
      } finally {
        elements.clearDeliveredButton.disabled = false;
      }
    });

    elements.closeOrderModal.addEventListener("click", closeOrderModal);
    elements.orderModal.addEventListener("click", (event) => { if (event.target === elements.orderModal) closeOrderModal(); });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeLogin();
        closeOrderModal();
      }
    });

  }

  async function initializeApp() {
    document.addEventListener("pointerdown", unlockSound, { once: true, capture: true });
    document.addEventListener("keydown", unlockSound, { once: true, capture: true });
    bindEvents();
    setConnectionState("connecting", "Connecting database");
    await loadOrders();
    subscribeToOrders();
    startRefreshFallback();

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadOrders({ silent: true });
    });
    window.addEventListener("online", () => loadOrders({ silent: true }));
    window.addEventListener("offline", () => setConnectionState("offline", "Internet offline"));

    routeSession();
  }

  initializeApp();
})();
