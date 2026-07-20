const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===================== NATIVE .ENV PARSER =====================
const envPath = path.join(__dirname, '.env');
const envConfig = {};

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/(^['"]|['"]$)/g, '');
      if (key) envConfig[key] = val;
    }
  });
}

const PORT = parseInt(envConfig.PORT) || 6000;

// ===================== HTTPS (wajib agar kamera bisa diakses dari HP/LAN) =====================
// Browser hanya mengizinkan getUserMedia (kamera) di secure context: HTTPS atau localhost.
const HTTPS_PORT = parseInt(envConfig.HTTPS_PORT) || PORT + 1;
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server.key');
const CRT_FILE = path.join(CERT_DIR, 'server.crt');
let httpsActive = false;

function lanIPs() {
  const os = require('os');
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
    }
  }
  return ips;
}

function ensureCert() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE)) return true;
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const sans = ['DNS:pkl.local', 'DNS:localhost', 'IP:127.0.0.1', ...lanIPs().map(ip => 'IP:' + ip)].join(',');
    require('child_process').execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "${KEY_FILE}" -out "${CRT_FILE}" -subj "/CN=pkl.local" -addext "subjectAltName=${sans}"`,
      { stdio: 'ignore' }
    );
    return true;
  } catch (e) {
    return false;
  }
}

// ===================== HASHING =====================
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin.toString()).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ===================== SESSION TOKENS (in-memory, 8 jam) =====================
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const activeTokens = new Map(); // token -> expiresAt

function issueToken() {
  const token = generateToken();
  activeTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function isValidToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  const exp = activeTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { activeTokens.delete(token); return false; }
  return true;
}

// Bersihkan token kedaluwarsa tiap jam
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of activeTokens) if (now > exp) activeTokens.delete(t);
}, 60 * 60 * 1000).unref();

// ===================== RATE LIMIT VERIFY-PIN =====================
const pinAttempts = new Map(); // ip -> { count, resetAt }
const PIN_MAX_ATTEMPTS = 10;
const PIN_WINDOW_MS = 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = pinAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    pinAttempts.set(ip, { count: 1, resetAt: now + PIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > PIN_MAX_ATTEMPTS;
}

// ===================== BACKUP =====================
const BACKUP_DIR = path.join(__dirname, 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// ===================== DATA STORE (JSON files) =====================
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILES = {
  students: path.join(DATA_DIR, 'students.json'),
  attendance: path.join(DATA_DIR, 'attendance.json'),
  schedules: path.join(DATA_DIR, 'schedules.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILES.students)) fs.writeFileSync(DATA_FILES.students, '[]', 'utf-8');
  if (!fs.existsSync(DATA_FILES.attendance)) fs.writeFileSync(DATA_FILES.attendance, '[]', 'utf-8');
  if (!fs.existsSync(DATA_FILES.schedules)) fs.writeFileSync(DATA_FILES.schedules, '{}', 'utf-8');
  if (!fs.existsSync(DATA_FILES.settings)) fs.writeFileSync(DATA_FILES.settings, '{}', 'utf-8');
}
ensureDataDir();

function readData(key) {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILES[key], 'utf-8'));
  } catch (e) {
    return key === 'schedules' || key === 'settings' ? {} : [];
  }
}

function writeData(key, data) {
  fs.writeFileSync(DATA_FILES[key], JSON.stringify(data, null, 2), 'utf-8');
}

// ===================== HELPERS =====================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ===================== MIME TYPES =====================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
// ===================== LOGGER =====================
function logEvent(tag, message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const reset = "\x1b[0m";
  let color = "\x1b[36m"; // Cyan untuk info
  if (type === 'success') color = "\x1b[32m"; // Green
  if (type === 'warn') color = "\x1b[33m"; // Yellow
  if (type === 'error') color = "\x1b[31m"; // Red

  console.log(`[${timestamp}] [${color}${tag.toUpperCase()}${reset}] ${message}`);
}

// ===================== SERVER =====================
const requestHandler = async (req, res) => {
  // CORS headers untuk akses LAN
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---------- API: Config (tanpa PIN & tanpa hash) ----------
  if (req.url === '/api/config' && req.method === 'GET') {
    logEvent('api', 'Config loaded by client');
    const settings = readData('settings') || {};
    jsonResponse(res, 200, {
      institution: settings.institution || envConfig.INSTITUTION || 'Sistem Absensi PKL',
      pin_length: settings.pin_length || 4,
      https_port: HTTPS_PORT,
      https_active: httpsActive,
    });
    return;
  }

  // ---------- API: DATA ENDPOINTS ----------
  // GET /api/students
  if (req.url === '/api/students' && req.method === 'GET') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    jsonResponse(res, 200, readData('students'));
    return;
  }
  // POST /api/students (replace all)
  if (req.url === '/api/students' && req.method === 'POST') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const data = await readBody(req);
      if (!Array.isArray(data)) { jsonResponse(res, 400, { error: 'Data harus array' }); return; }
      writeData('students', data);
      logEvent('data', `Students saved (${data.length} records)`, 'success');
      jsonResponse(res, 200, { ok: true });
    } catch (e) { jsonResponse(res, 400, { error: e.message }); }
    return;
  }
  // GET /api/attendance
  if (req.url === '/api/attendance' && req.method === 'GET') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    jsonResponse(res, 200, readData('attendance'));
    return;
  }
  // POST /api/attendance (replace all)
  if (req.url === '/api/attendance' && req.method === 'POST') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const data = await readBody(req);
      if (!Array.isArray(data)) { jsonResponse(res, 400, { error: 'Data harus array' }); return; }
      writeData('attendance', data);
      logEvent('data', `Attendance saved (${data.length} records)`, 'success');
      jsonResponse(res, 200, { ok: true });
    } catch (e) { jsonResponse(res, 400, { error: e.message }); }
    return;
  }
  // POST /api/attendance/append (tambah satu record, cegah duplikat)
  if (req.url === '/api/attendance/append' && req.method === 'POST') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const record = await readBody(req);
      const all = readData('attendance');
      if (record.type !== 'izin') {
        const dup = all.find(a => a.studentId === record.studentId && a.date === record.date && a.type === record.type);
        if (dup) { jsonResponse(res, 409, { error: 'Record sudah ada (scan ganda)' }); return; }
      } else {
        // Izin: hapus record hari itu dulu
        const filtered = all.filter(a => !(a.studentId === record.studentId && a.date === record.date));
        filtered.push(record);
        writeData('attendance', filtered);
        logEvent('data', `Izin/sakit: ${record.studentId} ${record.date}`, 'info');
        jsonResponse(res, 200, { ok: true }); return;
      }
      all.push(record);
      writeData('attendance', all);
      logEvent('data', `Attendance append: ${record.studentId} ${record.type} ${record.date}`, 'success');
      jsonResponse(res, 200, { ok: true });
    } catch (e) { jsonResponse(res, 400, { error: e.message }); }
    return;
  }
  // GET /api/schedules
  if (req.url === '/api/schedules' && req.method === 'GET') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    jsonResponse(res, 200, readData('schedules'));
    return;
  }
  // POST /api/schedules
  if (req.url === '/api/schedules' && req.method === 'POST') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const data = await readBody(req);
      writeData('schedules', data);
      logEvent('data', 'Schedules saved', 'success');
      jsonResponse(res, 200, { ok: true });
    } catch (e) { jsonResponse(res, 400, { error: e.message }); }
    return;
  }
  // GET /api/settings
  if (req.url === '/api/settings' && req.method === 'GET') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    jsonResponse(res, 200, readData('settings'));
    return;
  }
  // POST /api/settings
  if (req.url === '/api/settings' && req.method === 'POST') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const data = await readBody(req);
      writeData('settings', data);
      logEvent('data', 'Settings saved', 'success');
      jsonResponse(res, 200, { ok: true });
    } catch (e) { jsonResponse(res, 400, { error: e.message }); }
    return;
  }
  // POST /api/import — import data dari localStorage PC lain (one-shot, butuh token)
  if (req.url === '/api/import' && req.method === 'POST') {
    if (!isValidToken(req)) { jsonResponse(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const body = await readBody(req);
      if (body.students && Array.isArray(body.students)) {
        const existing = readData('students');
        const merged = [...existing];
        body.students.forEach(s => { if (!merged.find(e => e.id === s.id)) merged.push(s); });
        writeData('students', merged);
        logEvent('import', `Imported ${body.students.length} students (total: ${merged.length})`, 'success');
      }
      if (body.attendance && Array.isArray(body.attendance)) {
        const existing = readData('attendance');
        const merged = [...existing];
        body.attendance.forEach(a => { if (!merged.find(e => e.id === a.id)) merged.push(a); });
        writeData('attendance', merged);
        logEvent('import', `Imported ${body.attendance.length} attendance records (total: ${merged.length})`, 'success');
      }
      if (body.schedules && typeof body.schedules === 'object') {
        const existing = readData('schedules');
        writeData('schedules', { ...body.schedules, ...existing });
        logEvent('import', 'Schedules merged', 'success');
      }
      if (body.settings && typeof body.settings === 'object') {
        const existing = readData('settings');
        if (Object.keys(existing).length === 0) {
          writeData('settings', body.settings);
          logEvent('import', 'Settings imported', 'success');
        }
      }
      jsonResponse(res, 200, { ok: true, message: 'Import berhasil' });
    } catch (e) { jsonResponse(res, 400, { error: e.message }); }
    return;
  }

  // ---------- API: Client Log (browser kirim log ke terminal server) ----------
  if (req.url === '/api/log' && req.method === 'POST') {
    try {
      const { tag, message, type } = await readBody(req);
      if (tag && message) {
        logEvent(tag, message, type || 'info');
      }
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 400, { ok: false });
    }
    return;
  }

  // ---------- API: Verifikasi PIN di server ----------
  if (req.url === '/api/verify-pin' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      logEvent('auth', `Rate limited for IP: ${ip}`, 'error');
      jsonResponse(res, 429, { success: false, message: 'Terlalu banyak percobaan, coba lagi sebentar lagi' });
      return;
    }
    try {
      const { pin } = await readBody(req);
      if (!pin) {
        jsonResponse(res, 400, { success: false, message: 'PIN diperlukan' });
        return;
      }

      const settings = readData('settings') || {};
      const inputHashStr = hashPin(pin);

      let match = false;
      if (settings.pin_hash) {
        match = (inputHashStr === settings.pin_hash);
      } else {

        const defaultPin = envConfig.DEFAULT_PIN || '1234';
        const defaultHashStr = hashPin(defaultPin);
        match = (inputHashStr === defaultHashStr);
      }

      if (match) {
        const token = issueToken();
        logEvent('auth', `PIN verified successfully (IP: ${ip})`, 'success');
        jsonResponse(res, 200, { success: true, token });
      } else {
        logEvent('auth', `Incorrect PIN attempt (IP: ${ip})`, 'warn');
        jsonResponse(res, 401, { success: false, message: 'PIN salah' });
      }
    } catch (e) {
      logEvent('api', `Error verifying PIN: ${e.message}`, 'error');
      jsonResponse(res, 400, { success: false, message: 'Request tidak valid' });
    }
    return;
  }

  // ---------- API: Backup data (butuh token) ----------
  if (req.url === '/api/backup' && req.method === 'POST') {
    if (!isValidToken(req)) {
      logEvent('auth', 'Unauthorized backup attempt', 'warn');
      jsonResponse(res, 401, { success: false, message: 'Tidak terautentikasi' });
      return;
    }
    try {
      const data = await readBody(req);
      ensureBackupDir();

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `backup_${timestamp}.json`;
      const filePath = path.join(BACKUP_DIR, filename);

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

      // Hapus backup lama (simpan 30 terakhir)
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .sort();
      if (files.length > 30) {
        const toDelete = files.slice(0, files.length - 30);
        toDelete.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
      }

      logEvent('backup', `Auto-backup saved: ${filename}`, 'success');
      jsonResponse(res, 200, { success: true, filename });
    } catch (e) {
      logEvent('backup', `Failed to save backup: ${e.message}`, 'error');
      jsonResponse(res, 500, { success: false, message: 'Gagal menyimpan backup' });
    }
    return;
  }

  // ---------- API: List backups (butuh token) ----------
  if (req.url === '/api/backups' && req.method === 'GET') {
    if (!isValidToken(req)) {
      logEvent('auth', 'Unauthorized backups list attempt', 'warn');
      jsonResponse(res, 401, { success: false, message: 'Tidak terautentikasi' });
      return;
    }
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
      .sort()
      .reverse();
    logEvent('backup', 'Backups list retrieved');
    jsonResponse(res, 200, { backups: files });
    return;
  }

  // ---------- API: Restore backup (butuh token) ----------
  if (req.url.startsWith('/api/backup/') && req.method === 'GET') {
    if (!isValidToken(req)) {
      logEvent('auth', 'Unauthorized backup restore attempt', 'warn');
      jsonResponse(res, 401, { success: false, message: 'Tidak terautentikasi' });
      return;
    }
    const filename = req.url.replace('/api/backup/', '');
    if (!filename.match(/^backup_[\d-T]+\.json$/)) {
      logEvent('backup', `Invalid backup filename format: ${filename}`, 'warn');
      jsonResponse(res, 400, { success: false, message: 'Nama file tidak valid' });
      return;
    }
    const filePath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filePath)) {
      logEvent('backup', `Backup file not found: ${filename}`, 'warn');
      jsonResponse(res, 404, { success: false, message: 'Backup tidak ditemukan' });
      return;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    logEvent('backup', `Backup restored: ${filename}`, 'success');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
    return;
  }

  // ---------- Static Files ----------
  // Default ke login.html
  let urlPath = req.url === '/' ? '/login.html' : req.url;

  // Hilangkan query string jika ada
  try {
    urlPath = decodeURIComponent(urlPath.split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // Kunci request ke dalam folder projek & blokir dotfile (.env, .git)
  const filePath = path.join(__dirname, path.normalize(urlPath));
  const relative = path.relative(__dirname, filePath);
  if (relative.startsWith('..') || relative.split(path.sep).some(p => p.startsWith('.'))) {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<h1>403 Forbidden</h1>', 'utf-8');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        logEvent('server', `File not found: ${urlPath}`, 'warn');
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        logEvent('server', `Error serving ${urlPath}: ${error.code}`, 'error');
        res.writeHead(500);
        res.end(`Server Error: ${error.code} ..\n`);
      }
    } else {
      if (extname === '.html') {
        logEvent('page', `Served ${urlPath}`, 'success');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(content, 'utf-8');
    }
  });
};

const server = http.createServer(requestHandler);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logEvent('server', `Gagal menjalankan server! Port ${PORT} sudah digunakan oleh aplikasi lain.`, 'error');
    logEvent('server', `Solusi: Matikan aplikasi yang menggunakan port tersebut (seperti XAMPP/Apache, IIS, Skype, dll) atau ubah PORT di file .env.`, 'warn');
  } else {
    logEvent('server', `Terjadi error pada server: ${err.message}`, 'error');
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const domain = PORT === 80 ? 'http://pkl.local' : `http://pkl.local:${PORT}`;
  const local = PORT === 80 ? 'http://localhost' : `http://localhost:${PORT}`;
  console.log(`\n==================================================`);
  console.log(`SYSTEM ABSENSI PKL RUNNING ON LOCAL SERVER`);
  console.log(`Buka browser dan pergi ke:`);
  console.log(`👉 Domain: ${domain}`);
  console.log(`👉 Local : ${local}`);
  console.log(`==================================================\n`);
});

// HTTPS: dibutuhkan agar KAMERA scanner bisa dipakai dari HP / perangkat LAN.
// Sertifikat self-signed dibuat otomatis (sekali) — browser akan menampilkan
// peringatan "not private" sekali, pilih Advanced/Lanjutkan, setelah itu kamera aktif.
if (ensureCert()) {
  try {
    const httpsServer = https.createServer(
      { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE) },
      requestHandler
    );
    httpsServer.on('error', (err) => {
      logEvent('https', `HTTPS error: ${err.message}`, 'error');
    });
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      httpsActive = true;
      const ips = lanIPs();
      console.log(`==================================================`);
      console.log(`HTTPS AKTIF — WAJIB untuk scanner kamera di HP:`);
      console.log(`👉 https://pkl.local:${HTTPS_PORT}`);
      ips.forEach(ip => console.log(`👉 https://${ip}:${HTTPS_PORT}`));
      console.log(`(Peringatan sertifikat di browser cukup di-Lanjutkan sekali)`);
      console.log(`==================================================\n`);
    });
  } catch (e) {
    logEvent('https', `HTTPS tidak aktif: ${e.message}. Kamera hanya bisa dipakai via http://localhost:${PORT}`, 'warn');
  }
} else {
  logEvent('https', `Gagal membuat sertifikat (openssl tidak tersedia). Kamera hanya bisa dipakai via http://localhost:${PORT}, atau pakai fitur Upload Foto QR.`, 'warn');
}
