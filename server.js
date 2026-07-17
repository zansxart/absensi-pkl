const http = require('http');
const fs = require('fs');
const path = require('path');

// ===================== NATIVE .ENV PARSER =====================
const envPath = path.join(__dirname, '.env');
const envConfig = {
  PORT: 3000,
  DEFAULT_PIN: '1234',
  INSTITUTION: 'SMK PKL System'
};

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim().replace(/(^['"]|['"]$)/g, ''); // bersihkan tanda kutip
      if (key) envConfig[key] = val;
    }
  });
}

const PORT = parseInt(envConfig.PORT) || 3000;

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

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  // API Route untuk config .env
  if (req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      default_pin: envConfig.DEFAULT_PIN,
      institution: envConfig.INSTITUTION
    }));
    return;
  }

  // Default ke login.html
  let filePath = req.url === '/' ? './login.html' : '.' + req.url;
  
  // Hilangkan query string jika ada
  filePath = filePath.split('?')[0];

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
  console.log(`🎓 SYSTEM ABSENSI PKL RUNNING ON LOCAL SERVER`);
  console.log(`💻 Buka browser dan pergi ke: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
