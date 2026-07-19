const http = require('http');
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
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
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
const server = http.createServer(async (req, res) => {
  // ---------- API: Config (tanpa PIN & tanpa hash) ----------
  if (req.url === '/api/config' && req.method === 'GET') {
    logEvent('api', 'Config loaded by client');
    jsonResponse(res, 200, {
      institution: envConfig.INSTITUTION,
    });
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
      const inputHash = Buffer.from(hashPin(pin));
      const serverHash = Buffer.from(hashPin(envConfig.DEFAULT_PIN));
      if (inputHash.length === serverHash.length && crypto.timingSafeEqual(inputHash, serverHash)) {
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
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logEvent('server', `Gagal menjalankan server! Port ${PORT} sudah digunakan oleh aplikasi lain.`, 'error');
    logEvent('server', `Solusi: Matikan aplikasi yang menggunakan port tersebut (seperti XAMPP/Apache, IIS, Skype, dll) atau ubah PORT di file .env.`, 'warn');
  } else {
    logEvent('server', `Terjadi error pada server: ${err.message}`, 'error');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const domain = PORT === 80 ? 'http://pkl.local' : `http://pkl.local:${PORT}`;
  const local = PORT === 80 ? 'http://localhost' : `http://localhost:${PORT}`;
  console.log(`\n==================================================`);
  console.log(`SYSTEM ABSENSI PKL RUNNING ON LOCAL SERVER`);
  console.log(`Buka browser dan pergi ke:`);
  console.log(`👉 Domain: ${domain}`);
  console.log(`👉 Local : ${local}`);
  console.log(`==================================================\n`);
});
