pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const RENDER_SCALE = 2.0;
const WALL_LUMINANCE_THRESHOLD = 140;
const COLOR_SATURATION_THRESHOLD = 0.18;
const WALL_MIN_THICKNESS_PX = 3;
const GAP_BRIDGE_RADIUS = 8;

const state = {
  pdfDoc: null,
  pageNumber: 1,
  pdfImageData: null,
  closedWallMask: null,
  canvasWidth: 0,
  canvasHeight: 0,
  metersPerPixel: null,
  mode: 'idle', // idle | oneclick | calibrate
  calibratePoints: [],
  rooms: [], // {id, label, areaSqM, runRanges}
  pendingFill: null,
  fileId: null,
  fileUrl: null,
  currentProjectId: null,
};

const $ = (id) => document.getElementById(id);
const pdfCanvas = $('pdfCanvas');
const overlayCanvas = $('overlayCanvas');
const statusBar = $('statusBar');
const emptyState = $('emptyState');

function setStatus(msg) { statusBar.textContent = msg || ''; }

function setToolsEnabled(enabled) {
  ['oneClickBtn', 'calibrateBtn', 'undoBtn', 'clearBtn', 'saveBtn'].forEach((id) => {
    $(id).disabled = !enabled;
  });
}

// ---------- Wall detection (color + thickness) ----------
function luminanceAt(data, width, x, y) {
  const idx = (y * width + x) * 4;
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}
function isDarkPixel(data, width, x, y) {
  return luminanceAt(data, width, x, y) < WALL_LUMINANCE_THRESHOLD;
}
function isColoredLine(data, width, x, y) {
  const idx = (y * width + x) * 4;
  const r = data[idx], g = data[idx + 1], b = data[idx + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  return sat > COLOR_SATURATION_THRESHOLD;
}
function darkRun(data, width, height, x, y, dx, dy, maxCheck = 4) {
  let count = 0, cx = x, cy = y;
  for (let i = 0; i < maxCheck; i++) {
    cx += dx; cy += dy;
    if (cx < 0 || cx >= width || cy < 0 || cy >= height) break;
    if (isDarkPixel(data, width, cx, cy)) count++;
    else break;
  }
  return count;
}
function isWallPixel(data, width, height, x, y) {
  if (!isDarkPixel(data, width, x, y)) return false;
  if (isColoredLine(data, width, x, y)) return false;
  const hSpan = darkRun(data, width, height, x, y, -1, 0) + darkRun(data, width, height, x, y, 1, 0) + 1;
  const vSpan = darkRun(data, width, height, x, y, 0, -1) + darkRun(data, width, height, x, y, 0, 1) + 1;
  return Math.min(hSpan, vSpan) >= WALL_MIN_THICKNESS_PX;
}

// ---------- Gap bridging (morphological closing) ----------
function slidingMaxFast(arr, n, radius) {
  const out = new Uint8Array(n);
  const dq = new Int32Array(n);
  let head = 0, tail = 0, rIdx = 0;
  for (let i = 0; i < n; i++) {
    while (rIdx <= Math.min(n - 1, i + radius)) {
      while (tail > head && arr[dq[tail - 1]] <= arr[rIdx]) tail--;
      dq[tail++] = rIdx;
      rIdx++;
    }
    while (dq[head] < i - radius) head++;
    out[i] = arr[dq[head]];
  }
  return out;
}
function slidingMinFast(arr, n, radius) {
  const inv = new Uint8Array(n);
  for (let i = 0; i < n; i++) inv[i] = 255 - arr[i];
  const maxed = slidingMaxFast(inv, n, radius);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = 255 - maxed[i];
  return out;
}
function dilate2D(mask, width, height, radius) {
  const tmp = new Uint8Array(width * height);
  const row = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) row[x] = mask[y * width + x];
    const out = slidingMaxFast(row, width, radius);
    for (let x = 0; x < width; x++) tmp[y * width + x] = out[x];
  }
  const result = new Uint8Array(width * height);
  const col = new Uint8Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) col[y] = tmp[y * width + x];
    const out = slidingMaxFast(col, height, radius);
    for (let y = 0; y < height; y++) result[y * width + x] = out[y];
  }
  return result;
}
function erode2D(mask, width, height, radius) {
  const tmp = new Uint8Array(width * height);
  const row = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) row[x] = mask[y * width + x];
    const out = slidingMinFast(row, width, radius);
    for (let x = 0; x < width; x++) tmp[y * width + x] = out[x];
  }
  const result = new Uint8Array(width * height);
  const col = new Uint8Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) col[y] = tmp[y * width + x];
    const out = slidingMinFast(col, height, radius);
    for (let y = 0; y < height; y++) result[y * width + x] = out[y];
  }
  return result;
}
function buildClosedWallMask(imageData) {
  const { width, height, data } = imageData;
  const raw = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw[y * width + x] = isWallPixel(data, width, height, x, y) ? 255 : 0;
    }
  }
  const dilated = dilate2D(raw, width, height, GAP_BRIDGE_RADIUS);
  return erode2D(dilated, width, height, GAP_BRIDGE_RADIUS);
}

// ---------- Flood fill ----------
function floodFillRegion(width, height, startX, startY, closedWallMask) {
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) return null;
  const isWall = (x, y) => closedWallMask[y * width + x] > 0;
  if (isWall(startX, startY)) return { error: 'clicked-on-line' };

  const visited = new Uint8Array(width * height);
  const rowMap = new Map();
  const stack = [[startX, startY]];
  const HARD_CAP = Math.floor(width * height * 0.35);
  let filled = 0;
  let minX = startX, maxX = startX, minY = startY, maxY = startY;

  const isOpen = (x, y) => !visited[y * width + x] && !isWall(x, y);

  while (stack.length) {
    const [sx, sy] = stack.pop();
    if (visited[sy * width + sx]) continue;

    let xl = sx;
    while (xl - 1 >= 0 && isOpen(xl - 1, sy)) xl--;
    let xr = sx;
    while (xr + 1 < width && isOpen(xr + 1, sy)) xr++;

    for (let xx = xl; xx <= xr; xx++) {
      const vIdx = sy * width + xx;
      if (!visited[vIdx]) { visited[vIdx] = 1; filled++; }
    }
    if (filled > HARD_CAP) return { error: 'leaked' };

    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;

    if (!rowMap.has(sy)) rowMap.set(sy, []);
    rowMap.get(sy).push([xl, xr]);

    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let xx = xl;
      while (xx <= xr) {
        if (isOpen(xx, ny)) {
          stack.push([xx, ny]);
          while (xx <= xr && isOpen(xx, ny)) xx++;
        } else {
          xx++;
        }
      }
    }
  }

  const runRanges = [];
  for (const [y, segs] of rowMap.entries()) {
    segs.sort((a, b) => a[0] - b[0]);
    const merged = [segs[0]];
    for (let i = 1; i < segs.length; i++) {
      const last = merged[merged.length - 1];
      if (segs[i][0] <= last[1] + 1) last[1] = Math.max(last[1], segs[i][1]);
      else merged.push(segs[i]);
    }
    runRanges.push({ y, ranges: merged });
  }
  runRanges.sort((a, b) => a.y - b.y);

  return { filled, minX, maxX, minY, maxY, runRanges };
}

function pixelAreaToSqM(pixelCount) {
  if (!state.metersPerPixel) return null;
  return pixelCount * state.metersPerPixel * state.metersPerPixel;
}

// ---------- Rendering ----------
function redrawOverlay() {
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  state.rooms.forEach((room, idx) => {
    ctx.fillStyle = 'rgba(107, 31, 42, 0.28)';
    room.runRanges.forEach(({ y, ranges }) => {
      ranges.forEach(([xl, xr]) => ctx.fillRect(xl, y, xr - xl + 1, 1));
    });
    // label at centroid-ish (first row's midpoint)
    if (room.runRanges.length) {
      const midRow = room.runRanges[Math.floor(room.runRanges.length / 2)];
      const [xl, xr] = midRow.ranges[0];
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px sans-serif';
      const text = `${idx + 1}`;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(51,51,51,0.85)';
      ctx.fillRect((xl + xr) / 2 - tw / 2 - 4, midRow.y - 9, tw + 8, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, (xl + xr) / 2 - tw / 2, midRow.y + 4);
    }
  });
}

function renderTakeoffTable() {
  const tbody = $('takeoffBody');
  tbody.innerHTML = '';
  let total = 0;
  state.rooms.forEach((room, idx) => {
    total += room.areaSqM || 0;
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.className = 'room-name-edit';
    nameInput.value = room.label;
    nameInput.addEventListener('change', () => { room.label = nameInput.value; redrawOverlay(); });
    tdName.appendChild(nameInput);
    const tdArea = document.createElement('td');
    tdArea.textContent = room.areaSqM != null ? room.areaSqM.toFixed(2) : '—';
    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'row-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove room';
    delBtn.addEventListener('click', () => {
      state.rooms.splice(idx, 1);
      renderTakeoffTable();
      redrawOverlay();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdName); tr.appendChild(tdArea); tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  $('totalArea').textContent = `${total.toFixed(2)} m²`;
  $('exportBtn').disabled = !state.currentProjectId;
}

// ---------- PDF loading & scale detection ----------
async function loadPdf(url) {
  setStatus('Loading PDF...');
  emptyState.style.display = 'none';
  const loadingTask = pdfjsLib.getDocument(url);
  state.pdfDoc = await loadingTask.promise;
  state.pageNumber = 1;
  await renderPage();
}

async function detectScaleFromText(page, viewport) {
  try {
    const textContent = await page.getTextContent();
    const fullText = textContent.items.map((it) => it.str).join(' ');
    const match = fullText.match(/\b1\s*:\s*(\d{2,4})\b/);
    if (match) {
      const ratio = parseInt(match[1], 10);
      // 1 PDF point = 1/72 inch. At RENDER_SCALE, 1 rendered px = (1/72/RENDER_SCALE) inch = *0.0254m
      const metersPerPdfPoint = (1 / 72) * 0.0254 * ratio;
      const metersPerPixel = metersPerPdfPoint / RENDER_SCALE;
      return { metersPerPixel, ratio };
    }
  } catch (e) { /* fall through to manual calibration */ }
  return null;
}

async function renderPage() {
  const page = await state.pdfDoc.getPage(state.pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  pdfCanvas.width = overlayCanvas.width = viewport.width;
  pdfCanvas.height = overlayCanvas.height = viewport.height;
  state.canvasWidth = viewport.width;
  state.canvasHeight = viewport.height;

  const ctx = pdfCanvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  state.pdfImageData = ctx.getImageData(0, 0, viewport.width, viewport.height);

  const scaleResult = await detectScaleFromText(page, viewport);
  if (scaleResult) {
    state.metersPerPixel = scaleResult.metersPerPixel;
    $('scaleInfo').textContent = `Scale auto-detected: 1:${scaleResult.ratio}`;
  } else {
    state.metersPerPixel = null;
    $('scaleInfo').textContent = 'Scale not detected — use Manual Calibrate';
  }

  setStatus('Analyzing wall boundaries...');
  await new Promise((r) => setTimeout(r, 30)); // let status paint before the heavy synchronous pass
  state.closedWallMask = buildClosedWallMask(state.pdfImageData);
  setStatus('Ready. Click "One-Click Area" then click inside a room.');

  setToolsEnabled(true);
  redrawOverlay();
}

// ---------- Interaction ----------
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('Uploading PDF...');
  const formData = new FormData();
  formData.append('pdf', file);
  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.error) { setStatus(`Error: ${data.error}`); return; }
  state.fileId = data.fileId;
  state.fileUrl = data.url;
  state.rooms = [];
  state.currentProjectId = null;
  renderTakeoffTable();
  await loadPdf(data.url);
});

$('oneClickBtn').addEventListener('click', () => {
  state.mode = 'oneclick';
  setStatus('One-Click mode: click inside any room.');
});
$('calibrateBtn').addEventListener('click', () => {
  state.mode = 'calibrate';
  state.calibratePoints = [];
  setStatus('Calibration mode: click two points on a line of known length.');
});
$('undoBtn').addEventListener('click', () => {
  state.rooms.pop();
  renderTakeoffTable();
  redrawOverlay();
});
$('clearBtn').addEventListener('click', () => {
  state.rooms = [];
  renderTakeoffTable();
  redrawOverlay();
});

overlayCanvas.addEventListener('click', (e) => {
  const rect = overlayCanvas.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) * (overlayCanvas.width / rect.width));
  const y = Math.round((e.clientY - rect.top) * (overlayCanvas.height / rect.height));

  if (state.mode === 'oneclick') {
    if (!state.closedWallMask) { setStatus('Still analyzing walls — try again shortly.'); return; }
    const result = floodFillRegion(state.canvasWidth, state.canvasHeight, x, y, state.closedWallMask);
    if (!result) return;
    if (result.error === 'clicked-on-line') { setStatus('That looks like a wall — click inside an open room area.'); return; }
    if (result.error === 'leaked') { setStatus('Fill leaked across a broken boundary — try clicking more centrally, or check that wall on the drawing.'); return; }
    const areaSqM = pixelAreaToSqM(result.filled);
    state.pendingFill = { runRanges: result.runRanges, areaSqM };
    $('modalAreaPreview').textContent = areaSqM != null
      ? `Detected area: ${areaSqM.toFixed(2)} m²`
      : 'Area unavailable — calibrate scale first, you can still label and fix later.';
    $('roomLabelInput').value = `Room ${state.rooms.length + 1}`;
    $('labelModal').classList.remove('hidden');
  } else if (state.mode === 'calibrate') {
    state.calibratePoints.push([x, y]);
    if (state.calibratePoints.length === 2) {
      $('calibrateModal').classList.remove('hidden');
    }
  }
});

$('confirmLabelBtn').addEventListener('click', () => {
  if (!state.pendingFill) return;
  state.rooms.push({
    id: crypto.randomUUID(),
    label: $('roomLabelInput').value || `Room ${state.rooms.length + 1}`,
    areaSqM: state.pendingFill.areaSqM,
    runRanges: state.pendingFill.runRanges,
  });
  state.pendingFill = null;
  $('labelModal').classList.add('hidden');
  state.mode = 'idle';
  renderTakeoffTable();
  redrawOverlay();
  setStatus('Room added. Click "One-Click Area" to measure another room.');
});
$('cancelLabelBtn').addEventListener('click', () => {
  state.pendingFill = null;
  $('labelModal').classList.add('hidden');
  state.mode = 'idle';
});

$('confirmCalibrateBtn').addEventListener('click', () => {
  const realLength = parseFloat($('realLengthInput').value);
  if (!realLength || state.calibratePoints.length < 2) return;
  const [[x1, y1], [x2, y2]] = state.calibratePoints;
  const pixelDist = Math.hypot(x2 - x1, y2 - y1);
  state.metersPerPixel = realLength / pixelDist;
  $('scaleInfo').textContent = `Scale manually calibrated`;
  $('calibrateModal').classList.add('hidden');
  $('realLengthInput').value = '';
  state.calibratePoints = [];
  state.mode = 'idle';
  setStatus('Calibration applied.');
});
$('cancelCalibrateBtn').addEventListener('click', () => {
  $('calibrateModal').classList.add('hidden');
  state.calibratePoints = [];
  state.mode = 'idle';
});

$('saveBtn').addEventListener('click', () => {
  $('nameInput').value = '';
  $('descInput').value = '';
  $('saveModal').classList.remove('hidden');
});
$('cancelSaveBtn').addEventListener('click', () => $('saveModal').classList.add('hidden'));
$('confirmSaveBtn').addEventListener('click', async () => {
  const name = $('nameInput').value.trim();
  if (!name) return;
  const payload = {
    name,
    description: $('descInput').value.trim(),
    fileId: state.fileId,
    fileUrl: state.fileUrl,
    pageNumber: state.pageNumber,
    calibration: { metersPerPixel: state.metersPerPixel },
    rooms: state.rooms,
  };
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const saved = await res.json();
  state.currentProjectId = saved.id;
  $('saveModal').classList.add('hidden');
  renderTakeoffTable();
  await loadProjectList();
  setStatus('Project saved.');
});

$('exportBtn').addEventListener('click', () => {
  if (!state.currentProjectId) return;
  window.open(`/api/projects/${state.currentProjectId}/export.csv`, '_blank');
});

async function loadProjectList() {
  const res = await fetch('/api/projects');
  const list = await res.json();
  const ul = $('projectList');
  ul.innerHTML = '';
  list.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'project-item';
    li.innerHTML = `<span class="p-name">${p.name}</span><span class="p-meta">${p.totalArea.toFixed(2)} m²</span>`;
    const delBtn = document.createElement('button');
    delBtn.className = 'p-delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete "${p.name}"?`)) return;
      await fetch(`/api/projects/${p.id}`, { method: 'DELETE' });
      loadProjectList();
    });
    li.appendChild(delBtn);
    li.addEventListener('click', () => openProject(p.id));
    ul.appendChild(li);
  });
}

async function openProject(id) {
  setStatus('Opening saved project...');
  const res = await fetch(`/api/projects/${id}`);
  const project = await res.json();
  state.fileId = project.fileId;
  state.fileUrl = project.fileUrl;
  state.pageNumber = project.pageNumber || 1;
  state.currentProjectId = project.id;
  await loadPdf(project.fileUrl);
  if (project.calibration && project.calibration.metersPerPixel) {
    state.metersPerPixel = project.calibration.metersPerPixel;
    $('scaleInfo').textContent = 'Scale loaded from saved project';
  }
  state.rooms = (project.rooms || []).map((r) => ({ ...r, id: r.id || crypto.randomUUID() }));
  renderTakeoffTable();
  redrawOverlay();
  setStatus(`Opened "${project.name}".`);
}

loadProjectList();
