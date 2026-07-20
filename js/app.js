/**
 * app.js - Core data management & shared utilities
 * Sistem Absensi PKL
 */

// ===================== CONSTANTS =====================
const SETTINGS_KEY = 'pkl_settings';
const STUDENTS_KEY = 'pkl_students';
const ATTENDANCE_KEY = 'pkl_attendance';
const SESSION_KEY = 'pkl_auth_session';
const SCHEDULES_KEY = 'pkl_custom_schedules';
const VERSION = '1.0.0';

const DEFAULT_SETTINGS = {
  institution: '',
  jam_masuk: '08:00',
  jam_pulang: '16:00',
  jam_masuk_siang: '13:00',
  jam_pulang_siang: '21:00',
  toleransi_menit: 15,
  tahun_ajaran: '2025/2026',
  pin: '',
};

// ===================== AUTH TOKEN HELPER =====================
function getAuthToken() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return session && session.token ? session.token : null;
  } catch (e) { return null; }
}

async function apiCall(method, url, body = null) {
  const token = getAuthToken();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok && res.status === 401) {
    localStorage.removeItem(SESSION_KEY);
    if (!window.location.pathname.includes('login.html')) {
      window.location.href = 'login.html';
    }
    throw new Error('Sesi habis, silakan login kembali');
  }
  return res.json();
}

// ===================== DATA ACCESS LAYER (async, server-side JSON) =====================
const DB = {
  // --- CACHE IN-MEMORY (agar halaman tidak perlu fetch berulang per panggil) ---
  _cache: { students: null, attendance: null, schedules: null, settings: null },

  // Paksa refresh cache (dipanggil setelah save)
  _invalidate(key) { this._cache[key] = null; },

  async getStudents() {
    if (!this._cache.students) {
      this._cache.students = await apiCall('GET', '/api/students');
    }
    return this._cache.students || [];
  },
  async saveStudents(data) {
    await apiCall('POST', '/api/students', data);
    this._cache.students = data;
  },

  async getAttendance() {
    if (!this._cache.attendance) {
      this._cache.attendance = await apiCall('GET', '/api/attendance');
    }
    return this._cache.attendance || [];
  },
  async saveAttendance(data) {
    await apiCall('POST', '/api/attendance', data);
    this._cache.attendance = data;
  },
  async appendAttendance(record) {
    const res = await apiCall('POST', '/api/attendance/append', record);
    if (res.error) return { error: res.error };
    // Invalidate agar next call ambil fresh dari server
    this._invalidate('attendance');
    return { success: true };
  },

  async getSettings() {
    if (!this._cache.settings || Object.keys(this._cache.settings).length === 0) {
      this._cache.settings = await apiCall('GET', '/api/settings');
    }
    // Merge dengan default agar field yang belum ada di server tetap ada
    return { ...DEFAULT_SETTINGS, ...this._cache.settings };
  },
  async saveSettings(data) {
    await apiCall('POST', '/api/settings', data);
    this._cache.settings = data;
  },

  async getCustomSchedules() {
    if (!this._cache.schedules) {
      this._cache.schedules = await apiCall('GET', '/api/schedules');
    }
    return this._cache.schedules || {};
  },
  async saveCustomSchedules(data) {
    await apiCall('POST', '/api/schedules', data);
    this._cache.schedules = data;
  },

  async getStudentById(id) {
    const students = await this.getStudents();
    return students.find(s => s.id === id) || null;
  },
  async getAttendanceByStudentAndDate(studentId, date) {
    const all = await this.getAttendance();
    return all.filter(a => a.studentId === studentId && a.date === date);
  },
  async getTodayAttendance() {
    const today = getToday();
    const all = await this.getAttendance();
    return all.filter(a => a.date === today);
  },
  async getCustomSchedule(studentId, date) {
    const list = await this.getCustomSchedules();
    return list[`${studentId}_${date}`] || null;
  },
  async saveCustomSchedule(studentId, date, schedData) {
    const list = await this.getCustomSchedules();
    if (schedData === null) {
      delete list[`${studentId}_${date}`];
    } else {
      list[`${studentId}_${date}`] = schedData;
    }
    await this.saveCustomSchedules(list);
  },
};

// ===================== UTILITIES =====================
function getToday() {
  // Tanggal lokal (bukan UTC) — toISOString menggeser tanggal sebelum jam 07:00 WIB
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
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

// ===================== SERVER LOG (kirim log dari browser ke terminal server) =====================
function serverLog(tag, message, type = 'info') {
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, message, type })
  }).catch(() => {}); // silent fail jika server tidak bisa dihubungi
}

// ===================== ATTENDANCE LOGIC =====================
const Attendance = {
  /**
   * Hari kerja efektif: custom schedule menang atas aturan weekend.
   * customSchedules = cache objek (bukan async) untuk efisiensi di dalam loop.
   */
  getEffectiveDay(student, dateStr, customSchedules = {}) {
    const custom = customSchedules[`${student.id}_${dateStr}`] || null;
    const isOff = custom ? !!custom.isOff : isWeekend(dateStr);
    const shift = (custom && custom.shift) || student.shift || 'P';
    return { isOff, shift, custom };
  },

  /**
   * Rekam absensi masuk/keluar setelah scan QR
   * @returns Promise<{ status, type, record }|{ error }>
   */
  async record(studentId) {
    const [settings, student, allAttendance, customSchedules] = await Promise.all([
      DB.getSettings(),
      DB.getStudentById(studentId),
      DB.getAttendance(),
      DB.getCustomSchedules(),
    ]);
    if (!student) return { error: 'Siswa tidak ditemukan' };

    const today = getToday();
    const now = new Date();
    const nowTime = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace('.', ':');
    const nowMins = timeToMinutes(nowTime);
    const toleransiMins = parseInt(settings.toleransi_menit) || 0;

    // ---- Pulang lewat tengah malam (shift siang)
    if (nowMins < 6 * 60) {
      const yesterday = addDays(today, -1);
      const yRecords = allAttendance.filter(a => a.studentId === studentId && a.date === yesterday);
      const yMasuk = yRecords.find(r => r.type === 'masuk');
      const yPulang = yRecords.find(r => r.type === 'pulang');
      if (yMasuk && !yPulang) {
        const durasi = (1440 - timeToMinutes(yMasuk.time)) + nowMins;
        if (durasi < 120) return { error: 'Belum waktunya pulang (minimal 2 jam setelah masuk)' };
        const record = {
          id: generateId(), studentId, date: yesterday, type: 'pulang',
          timestamp: now.toISOString(), time: nowTime,
          overnight: true, status: 'info', statusLabel: 'Pulang (lewat tengah malam)',
          shift: yMasuk.shift || student.shift || 'S',
        };
        const saved = await DB.appendAttendance(record);
        if (saved.error) return { error: saved.error };
        return { record, student, type: 'pulang', status: record.status, statusLabel: record.statusLabel };
      }
    }

    if (student.startDate && today < student.startDate) return { error: 'Periode PKL belum dimulai' };
    if (student.endDate && today > student.endDate) return { error: 'Periode PKL sudah berakhir' };

    const eff = Attendance.getEffectiveDay(student, today, customSchedules);
    if (eff.isOff) return { error: 'Hari ini bukan hari kerja (libur/weekend) — scan tidak dicatat' };

    const todayRecords = allAttendance.filter(a => a.studentId === studentId && a.date === today);
    const hasMasuk = todayRecords.find(r => r.type === 'masuk');
    const hasPulang = todayRecords.find(r => r.type === 'pulang');
    const hasIzin = todayRecords.find(r => r.type === 'izin');

    if (hasIzin) {
      const lbl = hasIzin.kategori === 'sakit' ? 'Sakit' : 'Izin';
      return { error: `${student.name} sudah tercatat ${lbl} hari ini` };
    }

    const activeShift = hasMasuk ? (hasMasuk.shift || eff.shift) : eff.shift;
    const isSiang = activeShift === 'S';
    const jamMasuk = (isSiang ? settings.jam_masuk_siang : settings.jam_masuk) || '08:00';
    const jamMasukMins = timeToMinutes(jamMasuk);

    let type, statusLabel, statusClass;

    if (!hasMasuk) {
      type = 'masuk';
      if (nowMins <= jamMasukMins + toleransiMins) {
        statusLabel = 'Tepat Waktu'; statusClass = 'success';
      } else {
        const terlambat = nowMins - jamMasukMins;
        statusLabel = `Terlambat ${terlambat} menit`; statusClass = 'warning';
      }
    } else if (!hasPulang) {
      const masukTimeMins = timeToMinutes(hasMasuk.time);
      if (nowMins >= masukTimeMins + 120) {
        type = 'pulang';
        const jamPulang = (isSiang ? settings.jam_pulang_siang : settings.jam_pulang) || '16:00';
        const jamPulangMins = timeToMinutes(jamPulang);
        if (nowMins < jamPulangMins) {
          const selisih = jamPulangMins - nowMins;
          statusLabel = `Pulang Cepat ${selisih}m`; statusClass = 'danger';
        } else {
          statusLabel = 'Pulang'; statusClass = 'info';
        }
      } else {
        return { error: 'Belum waktunya pulang (minimal 2 jam setelah masuk)' };
      }
    } else {
      return { error: 'Sudah absen masuk dan pulang hari ini' };
    }

    const record = {
      id: generateId(), studentId, date: today, type,
      timestamp: now.toISOString(), time: nowTime,
      status: statusClass, statusLabel, shift: activeShift,
    };

    const saved = await DB.appendAttendance(record);
    if (saved.error) return { error: saved.error };
    return { record, student, type, status: statusClass, statusLabel };
  },

  /**
   * Hitung statistik kehadiran siswa (synchronous, menerima data cache sebagai parameter)
   */
  getMonthStats(studentId, year, month, allAttendance, allStudents, settings, customSchedules) {
    const days = getDaysInMonth(year, month);
    const student = (allStudents || []).find(s => s.id === studentId) || null;
    const today = getToday();
    let hadir = 0, terlambat = 0, alpha = 0, izin = 0, sakit = 0, workdays = 0;
    let earlyCheckinDays = 0, overtimeDays = 0, earlyCheckoutDays = 0;

    for (let d = 1; d <= days; d++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if (student?.startDate && dateStr < student.startDate) continue;
      if (student?.endDate && dateStr > student.endDate) continue;

      const records = (allAttendance || []).filter(a => a.studentId === studentId && a.date === dateStr);
      const masuk = records.find(r => r.type === 'masuk');
      const pulang = records.find(r => r.type === 'pulang');
      const izinRec = records.find(r => r.type === 'izin');

      const eff = student ? Attendance.getEffectiveDay(student, dateStr, customSchedules || {}) : { isOff: isWeekend(dateStr), shift: 'P' };
      if (eff.isOff && !masuk && !izinRec) continue;
      if (dateStr >= today && !masuk && !izinRec) continue;

      workdays++;
      if (izinRec) {
        if (izinRec.kategori === 'sakit') sakit++;
        else izin++;
      } else if (!masuk) {
        alpha++;
      } else {
        hadir++;
        if (masuk.status === 'warning') terlambat++;

        const shift = masuk.shift || eff.shift;
        const jamMasukS = ((settings || {}).jam_masuk_siang || '13:00');
        const jamMasukP = ((settings || {}).jam_masuk || '08:00');
        const jamMasukStr = shift === 'S' ? jamMasukS : jamMasukP;
        const jamMasukMins = timeToMinutes(jamMasukStr);
        const checkinMins = timeToMinutes(masuk.time);
        if (checkinMins <= jamMasukMins - 5) earlyCheckinDays++;

        if (pulang) {
          const jamPulangS = ((settings || {}).jam_pulang_siang || '21:00');
          const jamPulangP = ((settings || {}).jam_pulang || '16:00');
          const jamPulangStr = shift === 'S' ? jamPulangS : jamPulangP;
          const jamPulangMins = timeToMinutes(jamPulangStr);
          const checkoutMins = timeToMinutes(pulang.time) + (pulang.overnight ? 1440 : 0);
          if (checkoutMins >= jamPulangMins + 15) overtimeDays++;
          else if (checkoutMins < jamPulangMins) earlyCheckoutDays++;
        }
      }
    }

    const pct = workdays > 0 ? Math.round((hadir / workdays) * 100) : 0;
    return { hadir, terlambat, alpha, izin, sakit, workdays, pct, earlyCheckinDays, overtimeDays, earlyCheckoutDays };
  },

  /**
   * Tandai izin/sakit manual (async)
   */
  async markIzin(studentId, date, keterangan = '', kategori = 'izin', force = false) {
    const student = await DB.getStudentById(studentId);
    if (!student) return { error: 'Siswa tidak ditemukan' };
    if (student.startDate && date < student.startDate) return { error: 'Tanggal di luar periode PKL (sebelum mulai)' };
    if (student.endDate && date > student.endDate) return { error: 'Tanggal di luar periode PKL (sesudah selesai)' };
    if (date > getToday()) return { error: 'Tidak bisa menandai izin untuk tanggal yang belum terjadi' };

    const attendance = await DB.getAttendance();
    const existing = attendance.filter(a => a.studentId === studentId && a.date === date);
    const hasHadir = existing.some(a => a.type === 'masuk' || a.type === 'pulang');
    if (hasHadir && !force) return { error: 'Siswa sudah punya record hadir di tanggal ini', needConfirm: true };

    const record = {
      id: generateId(), studentId, date,
      type: 'izin', kategori: kategori === 'sakit' ? 'sakit' : 'izin',
      timestamp: new Date().toISOString(), time: '-', status: 'info',
      statusLabel: kategori === 'sakit' ? 'Sakit' : 'Izin', keterangan,
    };
    const res = await DB.appendAttendance(record);
    if (res.error) return { error: res.error };
    return { success: true };
  },

  /**
   * Dapatkan status sel jadwal (synchronous, menerima cache)
   */
  getCellStatus(studentId, dateStr, allStudents, allAttendance, customSchedules) {
    const student = (allStudents || []).find(s => s.id === studentId) || null;
    if (student?.startDate && dateStr < student.startDate) return { code: '', label: '', cls: '' };
    if (student?.endDate && dateStr > student.endDate) return { code: '', label: '', cls: '' };

    const records = (allAttendance || []).filter(a => a.studentId === studentId && a.date === dateStr);
    const masuk = records.find(r => r.type === 'masuk');
    const izin = records.find(r => r.type === 'izin');
    if (izin) {
      if (izin.kategori === 'sakit') return { code: 'SK', label: 'Sakit', cls: 'cell-sakit' };
      return { code: 'I', label: 'Izin', cls: 'cell-izin' };
    }

    const eff = student ? Attendance.getEffectiveDay(student, dateStr, customSchedules || {}) : { isOff: isWeekend(dateStr), shift: 'P' };
    if (eff.isOff && !masuk) return { code: 'L', label: 'Libur', cls: 'cell-libur' };

    if (!masuk) {
      const today = getToday();
      if (dateStr >= today) {
        const shift = eff.shift;
        return { code: shift, label: `Rencana Shift ${shift === 'P' ? 'Pagi' : 'Siang'}`, cls: shift === 'P' ? 'cell-planned-p' : 'cell-planned-s' };
      }
      return { code: 'A', label: 'Alpha', cls: 'cell-alpha' };
    }

    const shift = masuk.shift || eff.shift;
    if (masuk.status === 'warning') return { code: 'T', label: 'Terlambat', cls: 'cell-terlambat', shift };
    return { code: shift, label: shift === 'P' ? 'Pagi' : 'Siang', cls: shift === 'P' ? 'cell-hadir cell-shift-p' : 'cell-hadir cell-shift-s' };
  },
};

// ===================== EVALUATION =====================
const Evaluation = {
  calculate(studentId, year, month, allAttendance, allStudents, settings, customSchedules) {
    const stats = Attendance.getMonthStats(studentId, year, month, allAttendance, allStudents, settings, customSchedules);
    const student = (allStudents || []).find(s => s.id === studentId) || null;
    if (!student) return null;

    const nilaiKehadiran = stats.pct * 0.4;
    const penaltyTerlambat = (stats.terlambat || 0) * 5;
    const penaltyAlpha = (stats.alpha || 0) * 15;
    const penaltyPulangCepat = (stats.earlyCheckoutDays || 0) * 5;
    const bonusMasukAwal = (stats.earlyCheckinDays || 0) * 1;
    const bonusOvertime = (stats.overtimeDays || 0) * 1;
    const nilaiDisiplinRaw = Math.min(100, Math.max(0, 100 - (penaltyTerlambat + penaltyAlpha + penaltyPulangCepat) + (bonusMasukAwal + bonusOvertime)));
    const nilaiDisiplin = nilaiDisiplinRaw * 0.3;
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
    // Session harus punya token dan belum expired (8 jam)
    if (data.token && Date.now() - data.ts < 8 * 60 * 60 * 1000) return true;
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
  window.location.href = 'login.html';
  return false;
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = 'login.html';
}

// ===================== PWA (ikon "Install App" di HP/desktop) =====================
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ===================== INIT =====================
document.addEventListener('DOMContentLoaded', () => {
  const isLoginPage = window.location.pathname.includes('login.html');

  // Ambil config dari .env via API server
  fetch('/api/config')
    .then(res => res.json())
    .then(config => {
      if (config.institution) DEFAULT_SETTINGS.institution = config.institution;

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
      console.warn('Gagal memuat config dari server:', err);
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

  const sidebar = document.querySelector('.sidebar');

  // Sidebar Collapsible & Premium Dynamic Footer
  if (sidebar) {
    // 1. Render footer dynamically
    const footer = sidebar.querySelector('.sidebar-footer');
    if (footer) {
      footer.style.cssText = 'padding:16px 12px; border-top:1px solid var(--border); background:#f8fafc;';
      footer.innerHTML = `
        <div class="sidebar-user" style="display:flex; justify-content:space-between; align-items:center; width:100%; border:1px solid var(--border); padding:10px; border-radius:8px; background:var(--bg-secondary); transition:var(--transition);">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="avatar" style="width:32px; height:32px; border-radius:99px; background:var(--bg-card-hover); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:var(--text-primary);">A</div>
            <div class="user-info">
              <p style="font-size:12px; font-weight:600; color:var(--text-primary); margin:0;">Admin</p>
              <span style="font-size:10px; color:var(--text-muted);">Administrator</span>
            </div>
          </div>
          <button onclick="logout()" class="btn-logout" title="Logout" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; padding:6px; border-radius:6px; display:flex; align-items:center; justify-content:center; transition:var(--transition); margin-left: auto;">
            <svg style="width:18px; height:18px; stroke:currentColor; stroke-width:2; fill:none;" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      `;
    }

    // 2. Check local storage collapse state
    const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
    if (isCollapsed) {
      document.body.classList.add('sidebar-collapsed');
    }

    // 3. Add toggle button dynamically to header
    const logoHeader = sidebar.querySelector('.sidebar-logo');
    if (logoHeader && !document.getElementById('sidebar-toggle')) {
      const toggleBtn = document.createElement('button');
      toggleBtn.id = 'sidebar-toggle';
      toggleBtn.style.cssText = 'background:transparent; border:none; cursor:pointer; color:var(--text-muted); padding:6px; border-radius:6px; display:flex; align-items:center; justify-content:center; margin-left:auto; transition:var(--transition);';
      toggleBtn.innerHTML = '<svg style="width:16px; height:16px; stroke:currentColor; stroke-width:2; fill:none;" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"></polyline></svg>';
      logoHeader.appendChild(toggleBtn);

      toggleBtn.addEventListener('click', () => {
        const collapsed = document.body.classList.toggle('sidebar-collapsed');
        localStorage.setItem('sidebar_collapsed', collapsed ? 'true' : 'false');
      });
    }
  }

  // Mobile hamburger
  const hamburger = document.getElementById('hamburger');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => sidebar.classList.toggle('open'));
  }
}
