const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

[DATA_DIR, UPLOAD_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ projects: [] }, null, 2));

function readDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}.pdf`),
});
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  },
});

app.use(express.json({ limit: '20mb' }));
// Serve the frontend from public/ — index.html, style.css, app.js all live here.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.post('/api/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ fileId: req.file.filename, url: `/uploads/${req.file.filename}` });
});

app.get('/api/projects', (req, res) => {
  const db = readDB();
  const list = db.projects
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      totalArea: (p.rooms || []).reduce((s, r) => s + (r.areaSqM || 0), 0),
      createdAt: p.createdAt,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.get('/api/projects/:id', (req, res) => {
  const db = readDB();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json(project);
});

app.post('/api/projects', (req, res) => {
  const { name, description, fileId, fileUrl, calibration, rooms, pageNumber } = req.body;
  if (!name || !fileId) return res.status(400).json({ error: 'name and fileId are required' });
  const db = readDB();
  const project = {
    id: uuidv4(),
    name,
    description: description || '',
    fileId,
    fileUrl,
    pageNumber: pageNumber || 1,
    calibration: calibration || null,
    rooms: rooms || [],
    createdAt: new Date().toISOString(),
  };
  db.projects.push(project);
  writeDB(db);
  res.json(project);
});

app.delete('/api/projects/:id', (req, res) => {
  const db = readDB();
  db.projects = db.projects.filter((p) => p.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// CSV export of a saved project's takeoff table
app.get('/api/projects/:id/export.csv', (req, res) => {
  const db = readDB();
  const project = db.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const rows = [['Room', 'Area (sq m)']];
  (project.rooms || []).forEach((r) => rows.push([r.label || 'Unnamed', (r.areaSqM || 0).toFixed(2)]));
  const total = (project.rooms || []).reduce((s, r) => s + (r.areaSqM || 0), 0);
  rows.push(['TOTAL', total.toFixed(2)]);
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${(project.name || 'takeoff').replace(/[^a-z0-9]/gi, '_')}.csv"`);
  res.send(csv);
});

app.listen(PORT, () => console.log(`QM Takeoff server running on port ${PORT}`));
