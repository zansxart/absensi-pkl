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

const PORT = parseInt(envConfig.PORT);

// ===================== HASHING =====================
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin.toString()).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
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

// ===================== SERVER =====================
const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);

  // ---------- API: Config (tanpa PIN!) ----------
  if (req.url === '/api/config' && req.method === 'GET') {
    jsonResponse(res, 200, {
      institution: envConfig.INSTITUTION,
      pin_hash: hashPin(envConfig.DEFAULT_PIN), // kirim hash, bukan plaintext
    });
    return;
  }

  // ---------- API: Verifikasi PIN di server ----------
  if (req.url === '/api/verify-pin' && req.method === 'POST') {
    try {
      const { pin } = await readBody(req);
      if (!pin) {
        jsonResponse(res, 400, { success: false, message: 'PIN diperlukan' });
        return;
      }
      const inputHash = hashPin(pin);
      const serverHash = hashPin(envConfig.DEFAULT_PIN);
      if (inputHash === serverHash) {
        const token = generateToken();
        jsonResponse(res, 200, { success: true, token });
      } else {
        jsonResponse(res, 401, { success: false, message: 'PIN salah' });
      }
    } catch (e) {
      jsonResponse(res, 400, { success: false, message: 'Request tidak valid' });
    }
    return;
  }

  // ---------- API: Backup data ----------
  if (req.url === '/api/backup' && req.method === 'POST') {
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

      jsonResponse(res, 200, { success: true, filename });
    } catch (e) {
      jsonResponse(res, 500, { success: false, message: 'Gagal menyimpan backup' });
    }
    return;
  }

  // ---------- API: List backups ----------
  if (req.url === '/api/backups' && req.method === 'GET') {
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
      .sort()
      .reverse();
    jsonResponse(res, 200, { backups: files });
    return;
  }

  // ---------- API: Restore backup ----------
  if (req.url.startsWith('/api/backup/') && req.method === 'GET') {
    const filename = req.url.replace('/api/backup/', '');
    if (!filename.match(/^backup_[\d-T]+\.json$/)) {
      jsonResponse(res, 400, { success: false, message: 'Nama file tidak valid' });
      return;
    }
    const filePath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filePath)) {
      jsonResponse(res, 404, { success: false, message: 'Backup tidak ditemukan' });
      return;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
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
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code} ..\n`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`SYSTEM ABSENSI PKL RUNNING ON LOCAL SERVER`);
  console.log(`Buka browser dan pergi ke: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
