/**
 * app.js - Core data management & shared utilities
 * Sistem Absensi PKL
 */

// ===================== CONSTANTS =====================
const SETTINGS_KEY = 'pkl_settings';
const STUDENTS_KEY = 'pkl_students';
const ATTENDANCE_KEY = 'pkl_attendance';
const SESSION_KEY = 'pkl_auth_session';
const VERSION = '1.0.0';

const DEFAULT_SETTINGS = {
  institution: 'SMK PKL System',
  jam_masuk: '08:00',
  jam_pulang: '16:00',
  jam_masuk_siang: '13:00',
  jam_pulang_siang: '21:00',
  toleransi_menit: 15,
  tahun_ajaran: '2025/2026',
  pin: '1234',
};

// ===================== DATA ACCESS LAYER =====================
const DB = {
  getSettings() {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || DEFAULT_SETTINGS;
  },
  saveSettings(data) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  },
  getStudents() {
    return JSON.parse(localStorage.getItem(STUDENTS_KEY) || '[]');
  },
  saveStudents(data) {
    localStorage.setItem(STUDENTS_KEY, JSON.stringify(data));
  },
  getAttendance() {
    return JSON.parse(localStorage.getItem(ATTENDANCE_KEY) || '[]');
  },
  saveAttendance(data) {
    localStorage.setItem(ATTENDANCE_KEY, JSON.stringify(data));
  },
  getStudentById(id) {
    return DB.getStudents().find(s => s.id === id) || null;
  },
  getAttendanceByStudentAndDate(studentId, date) {
    return DB.getAttendance().filter(a => a.studentId === studentId && a.date === date);
  },
  getTodayAttendance() {
    const today = getToday();
    return DB.getAttendance().filter(a => a.date === today);
  },
};

// ===================== UTILITIES =====================
function getToday() {
  // Tanggal lokal (bukan UTC) — toISOString menggeser tanggal sebelum jam 07:00 WIB
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

function getCurrentTime() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().substr(0, 2);
}

function getDayName(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { weekday: 'short' }).toUpperCase().substr(0, 1);
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDay() === 0 || d.getDay() === 6;
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getMonthName(month) {
  const names = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
                 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return names[month];
}

// ===================== ATTENDANCE LOGIC =====================
const Attendance = {
  /**
   * Rekam absensi masuk/keluar setelah scan QR
   * @returns { status, type, record }
   */
  record(studentId) {
    const settings = DB.getSettings();
    const student = DB.getStudentById(studentId);
    if (!student) return { error: 'Siswa tidak ditemukan' };

    const today = getToday();
    const now = new Date();
    const nowTime = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace('.', ':');
    const nowMins = timeToMinutes(nowTime);

    // Jam kerja mengikuti shift siswa (P = pagi, S = siang)
    const isSiang = student.shift === 'S';
    const jamMasuk = (isSiang ? settings.jam_masuk_siang : settings.jam_masuk) || '08:00';
    const jamMasukMins = timeToMinutes(jamMasuk);
    const toleransiMins = parseInt(settings.toleransi_menit) || 0;

    let attendance = DB.getAttendance();
    const todayRecords = attendance.filter(a => a.studentId === studentId && a.date === today);
    const hasMasuk = todayRecords.find(r => r.type === 'masuk');
    const hasPulang = todayRecords.find(r => r.type === 'pulang');
    const hasIzin = todayRecords.find(r => r.type === 'izin');

    if (hasIzin) return { error: `${student.name} sudah tercatat Izin hari ini` };

    // Scan kedua dianggap pulang minimal 2 jam setelah jam masuk shift
    const midDay = jamMasukMins + 120;

    let type, statusLabel, statusClass;

    if (!hasMasuk) {
      // Scan pertama = masuk
      type = 'masuk';
      if (nowMins <= jamMasukMins + toleransiMins) {
        statusLabel = 'Tepat Waktu';
        statusClass = 'success';
      } else {
        const terlambat = nowMins - jamMasukMins;
        statusLabel = `Terlambat ${terlambat} menit`;
        statusClass = 'warning';
      }
    } else if (!hasPulang && nowMins >= midDay) {
      // Scan kedua (setelah setengah hari) = pulang
      type = 'pulang';
      statusLabel = 'Pulang';
      statusClass = 'info';
    } else if (hasMasuk && !hasPulang) {
      return { error: 'Belum waktunya pulang (minimal 2 jam setelah masuk)' };
    } else {
      return { error: 'Sudah absen masuk dan pulang hari ini' };
    }

    const record = {
      id: generateId(),
      studentId,
      date: today,
      type,
      timestamp: now.toISOString(),
      time: nowTime,
      status: statusClass,
      statusLabel,
    };

    attendance.push(record);
    DB.saveAttendance(attendance);

    return { record, student, type, status: statusClass, statusLabel };
  },

  /**
   * Hitung statistik kehadiran siswa dalam rentang bulan
   */
  getMonthStats(studentId, year, month) {
    const days = getDaysInMonth(year, month);
    const allAttendance = DB.getAttendance();
    const student = DB.getStudentById(studentId);
    const today = getToday();
    let hadir = 0, terlambat = 0, alpha = 0, izin = 0, workdays = 0;

    for (let d = 1; d <= days; d++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (isWeekend(dateStr)) continue;
      // Di luar periode PKL siswa → tidak dihitung
      if (student?.startDate && dateStr < student.startDate) continue;
      if (student?.endDate && dateStr > student.endDate) continue;

      const records = allAttendance.filter(a => a.studentId === studentId && a.date === dateStr);
      const masuk = records.find(r => r.type === 'masuk');
      const izinRec = records.find(r => r.type === 'izin');

      // Hari yang belum terjadi tidak dihitung sebagai hari kerja/alpha
      if (dateStr > today && !masuk && !izinRec) continue;

      workdays++;
      if (izinRec) {
        izin++;
      } else if (!masuk) {
        alpha++;
      } else if (masuk.status === 'warning') {
        terlambat++;
        hadir++;
      } else {
        hadir++;
      }
    }

    const pct = workdays > 0 ? Math.round((hadir / workdays) * 100) : 0;
    return { hadir, terlambat, alpha, izin, workdays, pct };
  },

  /**
   * Tandai izin manual
   */
  markIzin(studentId, date, keterangan = '') {
    let attendance = DB.getAttendance();
    // Izin menggantikan semua record hari itu (masuk/pulang/izin lama)
    attendance = attendance.filter(a => !(a.studentId === studentId && a.date === date));
    attendance.push({
      id: generateId(),
      studentId, date,
      type: 'izin',
      timestamp: new Date().toISOString(),
      time: '-', status: 'info',
      statusLabel: 'Izin',
      keterangan,
    });
    DB.saveAttendance(attendance);
  },

  /**
   * Dapatkan status sel jadwal untuk tanggal tertentu
   */
  getCellStatus(studentId, dateStr) {
    if (isWeekend(dateStr)) return { code: 'L', label: 'Libur', cls: 'cell-libur' };
    const student = DB.getStudentById(studentId);
    // Di luar periode PKL siswa → kosong, bukan Alpha
    if (student?.startDate && dateStr < student.startDate) return { code: '', label: '', cls: '' };
    if (student?.endDate && dateStr > student.endDate) return { code: '', label: '', cls: '' };
    const records = DB.getAttendance().filter(a => a.studentId === studentId && a.date === dateStr);
    const masuk = records.find(r => r.type === 'masuk');
    const izin = records.find(r => r.type === 'izin');
    if (izin) return { code: 'I', label: 'Izin', cls: 'cell-izin' };
    if (!masuk) {
      const today = getToday();
      if (dateStr >= today) return { code: '', label: '', cls: '' };
      return { code: 'A', label: 'Alpha', cls: 'cell-alpha' };
    }
    const shift = student?.shift || 'P';
    if (masuk.status === 'warning') return { code: 'T', label: 'Terlambat', cls: 'cell-terlambat', shift };
    return { code: shift, label: shift === 'P' ? 'Pagi' : 'Siang', cls: shift === 'P' ? 'cell-hadir cell-shift-p' : 'cell-hadir cell-shift-s' };
  },
};

// ===================== EVALUATION =====================
const Evaluation = {
  calculate(studentId, year, month) {
    const stats = Attendance.getMonthStats(studentId, year, month);
    const student = DB.getStudentById(studentId);
    if (!student) return null;

    // Nilai kehadiran (40%)
    const nilaiKehadiran = stats.pct * 0.4;

    // Nilai disiplin (30%) - kurang per keterlambatan
    const maxDisiplin = 100;
    const penaltyPerTerlambat = 5;
    const nilaiDisiplinRaw = Math.max(0, maxDisiplin - (stats.terlambat * penaltyPerTerlambat) - (stats.alpha * 15));
    const nilaiDisiplin = nilaiDisiplinRaw * 0.3;

    // Nilai sikap (30%) - input manual, default 80
    const nilaiSikap = (student.nilaiSikap || 80) * 0.3;

    const total = Math.round(nilaiKehadiran + nilaiDisiplin + nilaiSikap);

    let grade;
    if (total >= 90) grade = 'A';
    else if (total >= 80) grade = 'B';
    else if (total >= 70) grade = 'C';
    else grade = 'D';

    return { total, grade, nilaiKehadiran: Math.round(nilaiKehadiran), nilaiDisiplin: Math.round(nilaiDisiplinRaw), nilaiSikap: student.nilaiSikap || 80, stats };
  },
};

// ===================== HELPERS =====================

// ===================== TOAST NOTIFICATION =====================
function showToast(type, title, msg, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const svgs = {
    success: `<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    warning: `<svg viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    error: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${svgs[type] || svgs.info}</span>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${msg}</div>
    </div>
  `;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ===================== ACTIVE NAV =====================
function setActiveNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-item').forEach(item => {
    const href = item.getAttribute('href') || '';
    if (href.includes(path) || (path === 'index.html' && href === 'index.html')) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

// ===================== CLOCK =====================
function startClock() {
  const el = document.getElementById('topbar-time');
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

// ===================== SEED DATA (demo) =====================
function seedDemoData() {
  // Data dummy dinonaktifkan
}

// ===================== AUTH GUARD =====================
function requireAuth() {
  const session = localStorage.getItem(SESSION_KEY);
  if (!session) { window.location.href = 'login.html'; return false; }
  try {
    const data = JSON.parse(session);
    if (Date.now() - data.ts < 8 * 60 * 60 * 1000) return true;
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
  window.location.href = 'login.html';
  return false;
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = 'login.html';
}

// ===================== INIT =====================
document.addEventListener('DOMContentLoaded', () => {
  const isLoginPage = window.location.pathname.includes('login.html');

  // Ambil config dari .env via API server
  fetch('/api/config')
    .then(res => res.json())
    .then(config => {
      // Update default settings secara dinamis
      if (config.institution) DEFAULT_SETTINGS.institution = config.institution;
      if (config.default_pin) DEFAULT_SETTINGS.pin = config.default_pin;

      // Jika data setting belum ada di localStorage, buat baru
      if (!localStorage.getItem(SETTINGS_KEY)) {
        DB.saveSettings(DEFAULT_SETTINGS);
      }

      // Update UI nama instansi jika ada elemen terkait
      const instEl = document.getElementById('inst-name');
      if (instEl) instEl.textContent = config.institution || DEFAULT_SETTINGS.institution;

      // Jalankan auth guard setelah config siap
      if (!isLoginPage) {
        if (!requireAuth()) return;
      }
      
      initApp();
    })
    .catch(err => {
      console.warn('Gagal memuat config .env dari server, menggunakan default lokal:', err);
      if (!isLoginPage) {
        if (!requireAuth()) return;
      }
      initApp();
    });
});

function initApp() {
  seedDemoData();
  setActiveNav();
  startClock();

  // Update topbar date
  const dateEl = document.getElementById('topbar-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Mobile hamburger
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.querySelector('.sidebar');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => sidebar.classList.toggle('open'));
  }
}
