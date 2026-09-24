import {
  firebaseConfig,
  ADMIN_EMAILS,
  APP_TIME_ZONE,
  ATTENDANCE_COLLECTION,
  EMPLOYEE_SUBCOLLECTION,
  CURRENT_SETTINGS_DOC_PATH
} from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, onSnapshot, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

// ---------- Firebase init ----------
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const settingsRef = doc(db, CURRENT_SETTINGS_DOC_PATH);

// ---------- state ----------
let DATA = {
  period: "",
  periodKey: "",
  org: "",
  tahun: null,
  bulan: null,
  numDays: 0,
  employeeCount: 0
};
let currentEmployee = null;
let isAdmin = false;
let unsubscribePeriod = null;
let pendingParsed = null;

const $ = (sel) => document.querySelector(sel);
const el = (tag, props, ...kids) => {
  const n = document.createElement(tag);
  if (props) for (const k in props) {
    if (k === "class") n.className = props[k];
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), props[k]);
    else n.setAttribute(k, props[k]);
  }
  for (const k of kids) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};

// ---------- date/status helpers ----------
function getTodayParts() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: APP_TIME_ZONE || undefined,
      year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
  } catch (_) {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
}

function isDateCompleted(day) {
  if (!DATA.tahun || !DATA.bulan) return true;
  const now = getTodayParts();
  const periodValue = DATA.tahun * 10000 + DATA.bulan * 100 + day;
  const todayValue = now.year * 10000 + now.month * 100 + now.day;
  // Hari ini belum dianggap final karena pegawai masih mungkin absen pulang.
  return periodValue < todayValue;
}

function effectiveStatus(day) {
  if (!day) return "Kosong";
  const rawStatus = day.status || "Kosong";
  if (rawStatus === "Libur") return "Libur";
  // Pada hari ini/tanggal mendatang, hanya status yang belum final
  // (Kosong atau baru satu kali absen) yang ditahan sebagai Belum Berjalan.
  // Status yang sudah jelas seperti Dinas Luar, Izin, Cuti, Klaim, atau Hadir
  // tetap boleh terlihat oleh pegawai.
  if (!isDateCompleted(day.tgl) && (rawStatus === "Kosong" || rawStatus === "Hadir Sebagian")) {
    return "Belum Berjalan";
  }
  return rawStatus;
}

function employeeIssueDays(emp, status) {
  return (emp.days || []).filter(d => effectiveStatus(d) === status);
}

function employeeKosongDays(emp) {
  return employeeIssueDays(emp, "Kosong").map(d => d.tgl);
}

function employeePartialDays(emp) {
  return employeeIssueDays(emp, "Hadir Sebagian");
}

function formatDateLabel(tgl) {
  if (DATA.tahun && DATA.bulan) {
    const dt = new Date(DATA.tahun, DATA.bulan - 1, tgl);
    return dt.toLocaleDateString("id-ID", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });
  }
  return `Tanggal ${tgl}`;
}

function cleanPeriodLabel(value) {
  return String(value || "").replace(/^Laporan Rekap Bulanan\s*/i, "").trim();
}

function statusLabel(status) {
  const map = {
    "Hadir": "Hadir",
    "Hadir Sebagian": "Tidak Lengkap",
    "Dinas Luar": "Dinas Luar",
    "Ijin": "Izin",
    "Cuti": "Cuti",
    "Klaim": "Klaim",
    "Kosong": "Tanpa Data",
    "Libur": "Libur",
    "Belum Berjalan": "Belum Berjalan"
  };
  return map[status] || status || "—";
}

function statusClass(status) {
  return String(status || "").toLowerCase().replace(/\s+/g, "-");
}

function normalizeNip(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function sha256Hex(text) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error("Browser membutuhkan koneksi HTTPS untuk memproses NIP dengan aman.");
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- rendering ----------
function renderHeader() {
  $("#org-label").textContent = DATA.org || "e-Presensi Pegawai";
  $("#period-label").textContent = DATA.period
    ? cleanPeriodLabel(DATA.period)
    : "Belum ada periode aktif — admin perlu mengunggah rekap.";
}

function showNipScreen() {
  currentEmployee = null;
  $("#screen-detail").style.display = "none";
  $("#screen-nip").style.display = "block";
  $("#nip-input").value = "";
  setNipStatus("");
  setTimeout(() => $("#nip-input").focus(), 50);
  window.scrollTo({ top: 0 });
}

function openEmployee(emp) {
  currentEmployee = emp;
  $("#screen-nip").style.display = "none";
  $("#screen-detail").style.display = "block";
  renderDetail();
  window.scrollTo({ top: 0 });
}

function renderDetail() {
  const emp = currentEmployee;
  if (!emp) return;

  $("#d-nama").textContent = emp.nama || "—";
  $("#d-meta").textContent = emp.org || DATA.org || "Pegawai";
  $("#d-period").textContent = cleanPeriodLabel(DATA.period || DATA.periodKey || "Periode aktif");

  const kosongDays = employeeKosongDays(emp);
  const partialDays = employeePartialDays(emp);
  const alertBox = $("#alert-kosong");
  alertBox.innerHTML = "";

  if (kosongDays.length || partialDays.length) {
    alertBox.className = kosongDays.length ? "" : "warn";
    const parts = [];
    if (kosongDays.length) parts.push(`${kosongDays.length} hari tanpa data absensi`);
    if (partialDays.length) parts.push(`${partialDays.length} hari absensi tidak lengkap`);
    alertBox.append(
      el("div", { class: "title" }, parts.join(" · ")),
      el("div", { class: "desc" }, "Periksa tanggal yang ditandai. Hari ini, tanggal mendatang, Sabtu, dan Minggu tidak dihitung sebagai kekurangan.")
    );
  } else {
    alertBox.className = "ok";
    alertBox.append(
      el("div", { class: "title" }, "Tidak ada masalah absensi yang terdeteksi"),
      el("div", { class: "desc" }, "Semua hari kerja yang sudah selesai memiliki rekaman kehadiran atau keterangan.")
    );
  }

  renderSummary(emp);
  renderKosongList(kosongDays);
  renderPartialList(partialDays);
  renderHistory(emp);
}

function renderSummary(emp) {
  const grid = $("#summary-grid");
  grid.innerHTML = "";
  const statuses = [
    ["Hadir", "Hadir"],
    ["Dinas Luar", "Dinas Luar"],
    ["Ijin", "Izin"],
    ["Cuti", "Cuti"],
    ["Klaim", "Klaim"],
    ["Hadir Sebagian", "Tidak Lengkap"],
    ["Kosong", "Tanpa Data"]
  ];

  for (const [status, label] of statuses) {
    const count = employeeIssueDays(emp, status).length;
    grid.append(
      el("div", { class: `summary-card status-${statusClass(status)}` },
        el("span", { class: "summary-value" }, String(count)),
        el("span", { class: "summary-label" }, label)
      )
    );
  }
}

function renderKosongList(kosongDays) {
  const list = $("#kosong-list");
  list.innerHTML = "";
  if (kosongDays.length === 0) {
    list.append(el("li", { class: "kd-empty" }, "Tidak ada tanggal kosong pada hari kerja yang sudah selesai."));
    return;
  }
  for (const tgl of kosongDays) {
    list.append(el("li", null,
      el("span", { class: "kd-dot" }),
      el("span", { class: "kd-date" }, formatDateLabel(tgl))
    ));
  }
}

function renderPartialList(partialDays) {
  const list = $("#partial-list");
  list.innerHTML = "";
  if (partialDays.length === 0) {
    list.append(el("li", { class: "kd-empty" }, "Tidak ada absensi masuk/pulang yang tidak lengkap."));
    return;
  }
  for (const day of partialDays) {
    const detail = [`Masuk: ${day.masuk || "—"}`, `Pulang: ${day.pulang || "—"}`].join(" · ");
    list.append(el("li", null,
      el("span", { class: "kd-dot partial" }),
      el("span", { class: "kd-date" },
        formatDateLabel(day.tgl),
        el("small", null, detail)
      )
    ));
  }
}

function renderHistory(emp) {
  const wrap = $("#history-list");
  wrap.innerHTML = "";
  for (const day of emp.days || []) {
    const status = effectiveStatus(day);
    const timeParts = [];
    if (day.masuk) timeParts.push(`Masuk ${day.masuk}`);
    if (day.pulang) timeParts.push(`Pulang ${day.pulang}`);
    const detail = timeParts.length ? timeParts.join(" · ") : "Tidak ada jam masuk/pulang";

    wrap.append(
      el("div", { class: "history-row" },
        el("div", { class: "history-date" },
          el("strong", null, String(day.tgl).padStart(2, "0")),
          el("span", null, formatDateLabel(day.tgl).replace(/^\S+,\s*/, ""))
        ),
        el("div", { class: "history-info" },
          el("span", { class: `status-pill ${statusClass(status)}` }, statusLabel(status)),
          el("small", null, status === "Belum Berjalan" || status === "Libur" ? "—" : detail)
        )
      )
    );
  }
}

function updateSyncNote(text) {
  $("#sync-note").textContent = text || "";
}

function setNipStatus(msg, kind) {
  const s = $("#nip-status");
  s.textContent = msg || "";
  s.className = kind || "";
}

// ---------- NIP employee access ----------
async function lookupEmployeeByNip() {
  const nip = normalizeNip($("#nip-input").value);
  if (!/^\d{18}$/.test(nip)) {
    setNipStatus("Masukkan NIP 18 digit yang valid.", "err");
    return;
  }
  if (!DATA.periodKey) {
    setNipStatus("Periode presensi belum tersedia. Hubungi admin.", "err");
    return;
  }

  $("#nip-submit").disabled = true;
  setNipStatus("Memeriksa NIP…");
  try {
    const hash = await sha256Hex(nip);
    const empRef = doc(db, ATTENDANCE_COLLECTION, DATA.periodKey, EMPLOYEE_SUBCOLLECTION, hash);
    const snap = await getDoc(empRef);
    if (!snap.exists()) {
      setNipStatus("NIP tidak ditemukan pada rekap periode aktif. Periksa kembali NIP Anda atau hubungi admin.", "err");
      return;
    }
    setNipStatus("");
    openEmployee(snap.data());
  } catch (e) {
    console.error(e);
    setNipStatus(e?.message || "Gagal membaca data presensi. Periksa koneksi internet.", "err");
  } finally {
    $("#nip-submit").disabled = false;
  }
}

// ---------- Excel parsing ----------
const BULAN_MAP = { januari:1, februari:2, maret:3, april:4, mei:5, juni:6, juli:7, agustus:8, september:9, oktober:10, november:11, desember:12 };
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const STATUS_MAP = new Map([
  ["dinas luar", "Dinas Luar"],
  ["ijin", "Ijin"],
  ["izin", "Ijin"],
  ["cuti", "Cuti"],
  ["klaim", "Klaim"]
]);

function normalizeCell(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normalizeTime(v) {
  const s = normalizeCell(v);
  if (!s || !TIME_RE.test(s)) return null;
  const [h, m] = s.split(":");
  return `${String(Number(h)).padStart(2, "0")}:${m}`;
}

function periodKeyFromParsed(parsed) {
  if (!parsed.tahun || !parsed.bulan) throw new Error("Periode bulan/tahun tidak dapat dikenali dari judul laporan.");
  return `${parsed.tahun}-${String(parsed.bulan).padStart(2, "0")}`;
}

function parseWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  if (!wb.SheetNames.length) throw new Error("Workbook tidak memiliki sheet.");
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

  const period = (rows[0] && rows[0][0]) || "";
  const dayHeaderRow = rows[3] || [];
  let numDays = 0;
  for (let c = 5; c < dayHeaderRow.length; c++) {
    if (dayHeaderRow[c] == null || dayHeaderRow[c] === "") break;
    numDays++;
  }
  if (numDays === 0) numDays = 31;

  const m = String(period).match(/(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u);
  let tahun = null, bulan = null;
  const weekendDays = new Set();
  if (m) {
    bulan = BULAN_MAP[m[2].toLowerCase()] || null;
    tahun = parseInt(m[3], 10);
    if (bulan) {
      for (let d = 1; d <= numDays; d++) {
        const dt = new Date(tahun, bulan - 1, d);
        if (dt.getMonth() !== bulan - 1) continue;
        const wd = dt.getDay();
        if (wd === 0 || wd === 6) weekendDays.add(d);
      }
    }
  }

  function classify(c1, c2, c3, daynum) {
    const vals = [c1, c2, c3].map(normalizeCell);
    for (const v of vals) {
      if (!v) continue;
      const known = STATUS_MAP.get(v.toLowerCase());
      if (known) return { status: known, masuk: null, pulang: null };
    }
    const masuk = normalizeTime(c1);
    const pulang = normalizeTime(c3);
    if (masuk && pulang) return { status: "Hadir", masuk, pulang };
    if (masuk || pulang) return { status: "Hadir Sebagian", masuk, pulang };
    if (weekendDays.has(daynum)) return { status: "Libur", masuk: null, pulang: null };
    return { status: "Kosong", masuk: null, pulang: null };
  }

  const employees = [];
  const seenNips = new Set();
  let r = 4;
  while (r < rows.length) {
    const row = rows[r] || [];
    const no = row[0];
    if (no == null || no === "") break;

    const org = normalizeCell(row[2]);
    const nama = normalizeCell(row[3]);
    const nip = normalizeNip(row[4]);
    if (!/^\d{18}$/.test(nip)) {
      throw new Error(`NIP tidak valid pada pegawai ${nama || `baris ${r + 1}`}. Harus 18 digit.`);
    }
    if (seenNips.has(nip)) {
      throw new Error(`NIP duplikat ditemukan pada pegawai ${nama || nip}.`);
    }
    seenNips.add(nip);

    const row1 = rows[r] || [], row2 = rows[r + 1] || [], row3 = rows[r + 2] || [];
    const days = [];
    for (let i = 0; i < numDays; i++) {
      const col = 5 + i;
      days.push({ tgl: i + 1, ...classify(row1[col], row2[col], row3[col], i + 1) });
    }

    employees.push({ no, nip, org, nama, days });
    r += 3;
  }

  if (employees.length === 0) {
    throw new Error("Tidak ditemukan baris data pegawai. Pastikan file sesuai format rekap bulanan.");
  }
  if (!tahun || !bulan) {
    throw new Error("Periode bulan/tahun pada judul laporan tidak dapat dikenali.");
  }

  const parsed = {
    period,
    org: employees[0].org || "",
    tahun,
    bulan,
    numDays,
    employees,
    updatedAt: new Date().toISOString()
  };
  parsed.periodKey = periodKeyFromParsed(parsed);
  return parsed;
}

// ---------- admin auth ----------
function adminEmailAllowed(email) {
  const allowed = (ADMIN_EMAILS || []).map(v => String(v).trim().toLowerCase()).filter(Boolean);
  return !!email && allowed.includes(String(email).trim().toLowerCase());
}

function openLogin() {
  $("#login-email").value = "";
  $("#login-password").value = "";
  setLoginStatus("");
  $("#login-overlay").style.display = "flex";
}
function closeLogin() { $("#login-overlay").style.display = "none"; }
function setLoginStatus(msg, kind) {
  const s = $("#login-status");
  s.textContent = msg || "";
  s.className = kind || "";
}

async function doLogin() {
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  if (!email || !password) { setLoginStatus("Isi email dan kata sandi.", "err"); return; }
  setLoginStatus("Memproses…");
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    if (!adminEmailAllowed(credential.user.email)) {
      await signOut(auth);
      setLoginStatus("Akun berhasil dikenali, tetapi tidak terdaftar sebagai admin aplikasi.", "err");
      return;
    }
    setLoginStatus("Berhasil masuk sebagai admin.", "ok");
    setTimeout(closeLogin, 500);
  } catch (_) {
    setLoginStatus("Gagal masuk: periksa email/kata sandi.", "err");
  }
}

// ---------- admin upload & save ----------
function setAdminStatus(msg, kind) {
  const s = $("#admin-status");
  s.textContent = msg || "";
  s.className = kind || "";
}

async function handleFile(file) {
  pendingParsed = null;
  $("#admin-confirm").disabled = true;
  $("#admin-preview").style.display = "none";

  if (!/\.(xlsx|xls)$/i.test(file.name || "")) {
    setAdminStatus("Format file harus .xlsx atau .xls.", "err");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    setAdminStatus("Ukuran file terlalu besar. Batas aplikasi 10 MB.", "err");
    return;
  }

  setAdminStatus("Membaca dan memvalidasi file…");
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseWorkbook(buf);
    pendingParsed = parsed;
    $("#admin-preview").style.display = "block";
    $("#admin-preview").textContent =
      `Periode: ${cleanPeriodLabel(parsed.period)}\n` +
      `Arsip Firestore: ${ATTENDANCE_COLLECTION}/${parsed.periodKey}\n` +
      `Jumlah pegawai/NIP valid: ${parsed.employees.length}\n` +
      `Jumlah hari: ${parsed.numDays}\n` +
      `Privasi: NIP mentah tidak akan disimpan ke Firestore.`;
    setAdminStatus("File berhasil dibaca. Periksa ringkasan, lalu simpan.", "ok");
    $("#admin-confirm").disabled = false;
  } catch (e) {
    setAdminStatus("Gagal membaca file: " + e.message, "err");
  }
}

async function buildEmployeeWriteData(parsed) {
  const result = [];
  for (const emp of parsed.employees) {
    const employeeHash = await sha256Hex(emp.nip);
    result.push({
      employeeHash,
      data: {
        no: emp.no,
        org: emp.org,
        nama: emp.nama,
        days: emp.days,
        updatedAt: parsed.updatedAt
      }
    });
  }
  return result;
}

async function confirmSave() {
  if (!pendingParsed || !isAdmin) return;
  $("#admin-confirm").disabled = true;
  setAdminStatus("Mengamankan NIP dan menyiapkan arsip pegawai…");

  try {
    const employeeWrites = await buildEmployeeWriteData(pendingParsed);
    const employeeCollection = collection(
      db,
      ATTENDANCE_COLLECTION,
      pendingParsed.periodKey,
      EMPLOYEE_SUBCOLLECTION
    );

    // Admin boleh membaca daftar hanya untuk membersihkan data lama pada periode yang sama.
    const oldSnapshot = await getDocs(employeeCollection);
    const oldRefs = oldSnapshot.docs.map(d => d.ref);

    const operations = [];
    for (const oldRef of oldRefs) operations.push({ type: "delete", ref: oldRef });
    for (const item of employeeWrites) {
      operations.push({
        type: "set",
        ref: doc(employeeCollection, item.employeeHash),
        data: item.data
      });
    }

    const periodRef = doc(db, ATTENDANCE_COLLECTION, pendingParsed.periodKey);
    operations.push({
      type: "set",
      ref: periodRef,
      data: {
        period: pendingParsed.period,
        periodKey: pendingParsed.periodKey,
        org: pendingParsed.org,
        tahun: pendingParsed.tahun,
        bulan: pendingParsed.bulan,
        numDays: pendingParsed.numDays,
        employeeCount: pendingParsed.employees.length,
        storageVersion: 3,
        updatedAt: pendingParsed.updatedAt
      }
    });
    operations.push({
      type: "set",
      ref: settingsRef,
      data: {
        activePeriod: pendingParsed.periodKey,
        storageVersion: 3,
        updatedAt: new Date().toISOString()
      },
      options: { merge: true }
    });

    // Firestore batch maksimal 500 operasi. Gunakan 450 agar ada ruang aman.
    for (let i = 0; i < operations.length; i += 450) {
      const batch = writeBatch(db);
      for (const op of operations.slice(i, i + 450)) {
        if (op.type === "delete") batch.delete(op.ref);
        else if (op.options) batch.set(op.ref, op.data, op.options);
        else batch.set(op.ref, op.data);
      }
      await batch.commit();
    }

    setAdminStatus(`Berhasil. ${pendingParsed.employees.length} pegawai disimpan pada periode ${pendingParsed.periodKey}.`, "ok");
    setTimeout(closeAdmin, 900);
  } catch (e) {
    console.error(e);
    setAdminStatus(
      "Gagal menyimpan: " + (e?.message || e) + " — periksa email admin, firestore.rules, HTTPS, dan konfigurasi Firebase.",
      "err"
    );
    $("#admin-confirm").disabled = false;
  }
}

function openAdmin() {
  pendingParsed = null;
  $("#admin-confirm").disabled = true;
  $("#admin-preview").style.display = "none";
  setAdminStatus("");
  $("#file-input").value = "";
  $("#admin-overlay").style.display = "flex";
}
function closeAdmin() { $("#admin-overlay").style.display = "none"; }

// ---------- wiring ----------
$("#nip-form").addEventListener("submit", (e) => {
  e.preventDefault();
  lookupEmployeeByNip();
});
$("#nip-input").addEventListener("input", (e) => {
  e.target.value = normalizeNip(e.target.value).slice(0, 18);
  if ($("#nip-status").className === "err") setNipStatus("");
});
$("#back-btn").addEventListener("click", showNipScreen);

$("#admin-login-btn").addEventListener("click", () => {
  if (isAdmin) openAdmin(); else openLogin();
});
$("#admin-logout-btn").addEventListener("click", () => signOut(auth));
$("#login-close").addEventListener("click", closeLogin);
$("#login-cancel").addEventListener("click", closeLogin);
$("#login-submit").addEventListener("click", doLogin);
$("#login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("#login-overlay").addEventListener("click", (e) => { if (e.target.id === "login-overlay") closeLogin(); });

$("#admin-close").addEventListener("click", closeAdmin);
$("#admin-cancel").addEventListener("click", closeAdmin);
$("#admin-overlay").addEventListener("click", (e) => { if (e.target.id === "admin-overlay") closeAdmin(); });
$("#file-drop").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
$("#file-drop").addEventListener("dragover", (e) => e.preventDefault());
$("#file-drop").addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
$("#admin-confirm").addEventListener("click", confirmSave);

// ---------- auth state ----------
onAuthStateChanged(auth, (user) => {
  isAdmin = !!user && adminEmailAllowed(user.email);
  $("#admin-login-btn").textContent = isAdmin ? "Admin: Unggah Data" : "Admin";
  $("#admin-logout-btn").style.display = isAdmin ? "inline-block" : "none";
});

// ---------- realtime active period ----------
function applyPeriodData(periodKey, data) {
  DATA = {
    period: data?.period || periodKey,
    periodKey,
    org: data?.org || "",
    tahun: Number(data?.tahun) || null,
    bulan: Number(data?.bulan) || null,
    numDays: Number(data?.numDays) || 0,
    employeeCount: Number(data?.employeeCount) || 0
  };
  renderHeader();
  updateSyncNote(`Periode ${periodKey} aktif · ${DATA.employeeCount || 0} pegawai terdaftar.`);
}

function listenPeriod(periodKey) {
  if (unsubscribePeriod) unsubscribePeriod();
  const periodRef = doc(db, ATTENDANCE_COLLECTION, periodKey);
  unsubscribePeriod = onSnapshot(periodRef, (snap) => {
    if (snap.exists()) {
      const previousKey = DATA.periodKey;
      applyPeriodData(periodKey, snap.data());
      if (currentEmployee && previousKey && previousKey !== periodKey) showNipScreen();
    } else {
      DATA = { period: "", periodKey, org: "", tahun: null, bulan: null, numDays: 0, employeeCount: 0 };
      renderHeader();
      updateSyncNote(`Periode aktif ${periodKey} belum memiliki data. Admin perlu mengunggah rekap.`);
    }
  }, (err) => {
    console.error(err);
    updateSyncNote("Tidak dapat membaca metadata periode aktif. Periksa Firestore Rules dan koneksi internet.");
  });
}

onSnapshot(settingsRef, (snap) => {
  const activePeriod = snap.exists() ? snap.data()?.activePeriod : null;
  if (activePeriod) listenPeriod(activePeriod);
  else {
    DATA = { period: "", periodKey: "", org: "", tahun: null, bulan: null, numDays: 0, employeeCount: 0 };
    renderHeader();
    updateSyncNote("Belum ada periode aktif. Admin perlu login dan mengunggah rekap pertama kali.");
  }
}, (err) => {
  console.error(err);
  updateSyncNote("Tidak dapat terhubung ke Firebase. Periksa konfigurasi, Firestore Rules, dan koneksi internet.");
});

renderHeader();
showNipScreen();
