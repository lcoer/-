const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Android screenshots use non-interlaced 8-bit PNG. Unsupported formats fail closed.
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG');
  let width, height, channels, palette, alpha, ended = false;
  const compressed = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const size = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    if (offset + size + 12 > buffer.length) throw new Error('Truncated PNG');
    const chunk = buffer.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[chunk[9]];
      if (!width || !height || width * height > 16e6 || chunk[8] !== 8 || !channels || chunk[10] || chunk[11] || chunk[12]) throw new Error('Unsupported PNG');
    } else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') alpha = chunk;
    else if (type === 'IDAT') compressed.push(chunk);
    else if (type === 'IEND') { ended = true; break; }
    offset += size + 12;
  }
  if (!ended || !channels) throw new Error('Incomplete PNG');
  const stride = width * channels, raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid PNG length');
  const decoded = Buffer.alloc(stride * height), data = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= channels ? decoded[i - channels] : 0, b = y ? decoded[i - stride] : 0, c = y && x >= channels ? decoded[i - stride - channels] : 0;
      decoded[i] = (raw[y * (stride + 1) + x + 1] + [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]) & 255;
    }
  }
  for (let i = 0; i < width * height; i++) {
    const p = i * channels, out = i * 4;
    if (palette) { const ix = decoded[p]; data[out] = palette[ix * 3]; data[out + 1] = palette[ix * 3 + 1]; data[out + 2] = palette[ix * 3 + 2]; data[out + 3] = alpha?.[ix] ?? 255; }
    else if (channels < 3) { data[out] = data[out + 1] = data[out + 2] = decoded[p]; data[out + 3] = channels === 2 ? decoded[p + 1] : 255; }
    else { data[out] = decoded[p]; data[out + 1] = decoded[p + 1]; data[out + 2] = decoded[p + 2]; data[out + 3] = channels === 4 ? decoded[p + 3] : 255; }
  }
  return { width, height, data };
}

function symbolFeatures(image, roi, thresholdMode = 0) {
  const { width, height, data } = image;
  const r = roi || { x: 0, y: 0, width, height };
  if (![r.x, r.y, r.width, r.height].every(Number.isInteger) || r.x < 0 || r.y < 0 || r.width < 8 || r.height < 8 || r.x + r.width > width || r.y + r.height > height) return null;
  const w = r.width, h = r.height;
  const values = [], light = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = ((r.y + y) * width + r.x + x) * 4;
    const v = data[p + 3] < 128 ? 0 : data[p] * .299 + data[p + 1] * .587 + data[p + 2] * .114;
    light[y * w + x] = v; values.push(v);
  }
  values.sort((a, b) => a - b);
  const low = values[Math.floor(values.length * .15)], high = values[Math.floor(values.length * .9)];
  if (high - low < 10) return null;
  const median = values[Math.floor(values.length * .5)], peak = values[Math.floor(values.length * .98)];
  // The robust median handles bright backgrounds; the peak branch handles padded/dim ROIs.
  const threshold = thresholdMode ? low + (peak - low) * .65 : Math.max(low + (high - low) * .6, median + (peak - median) * .5), seen = new Uint8Array(w * h), candidates = [];
  for (let i = 0; i < light.length; i++) {
    if (seen[i] || light[i] < threshold) continue;
    const queue = [i]; seen[i] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let k = 0; k < queue.length; k++) {
      const index = queue[k], x = index % w, y = Math.floor(index / w);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const next of [x ? index - 1 : -1, x + 1 < w ? index + 1 : -1, y ? index - w : -1, y + 1 < h ? index + w : -1]) {
        if (next >= 0 && !seen[next] && light[next] >= threshold) { seen[next] = 1; queue.push(next); }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw >= 8 && bh >= 8 && bw / bh > .75 && bw / bh < 1.3 && queue.length / (bw * bh) > .4) candidates.push({ x0, y0, bw, bh, area: queue.length });
  }
  candidates.sort((a, b) => b.area - a.area);
  if (!candidates.length) return null;
  const features = [];
  for (const box of candidates) {
    let chroma = 0;
    const grid = [];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      const sx = box.x0 + Math.min(box.bw - 1, Math.floor((x + .5) * box.bw / 20)), sy = box.y0 + Math.min(box.bh - 1, Math.floor((y + .5) * box.bh / 20));
      const p = ((r.y + sy) * width + r.x + sx) * 4;
      chroma += Math.max(data[p], data[p + 1], data[p + 2]) - Math.min(data[p], data[p + 1], data[p + 2]);
      grid.push(light[sy * w + sx]);
    }
    // Normalize within this disc: surrounding page colors must not flatten its symbol.
    const min = Math.min(...grid), max = Math.max(...grid);
    if (chroma / 400 >= 8 && max - min >= 10) features.push(grid.map(v => (v - min) / (max - min)));
  }
  return features.length ? features : null;
}

let templates;
function similarity(a, b) {
  let best = -1;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const av = [], bv = [];
    // Interior carries the symbol; the common circular border cannot dominate the score.
    for (let y = 3; y < 17; y++) for (let x = 3; x < 17; x++) { av.push(a[y * 20 + x]); bv.push(b[(y + dy) * 20 + x + dx]); }
    const am = av.reduce((s, v) => s + v, 0) / av.length, bm = bv.reduce((s, v) => s + v, 0) / bv.length;
    let dot = 0, aa = 0, bb = 0;
    for (let i = 0; i < av.length; i++) { const da = av[i] - am, db = bv[i] - bm; dot += da * db; aa += da * da; bb += db * db; }
    best = Math.max(best, aa > .5 && bb > .5 ? dot / Math.sqrt(aa * bb) : -1);
  }
  return best;
}

// ROI contains one gender icon (optionally the adjacent age badge), never a whole user row.
// Age digits are deliberately excluded. This is a template score, not a probability.
function classifyGenderBadge(input, roi) {
  const unknown = { sex: '未知', confidence: 0, source: 'gender-symbol' };
  try {
    const image = Buffer.isBuffer(input) ? decodePng(input) : input;
    if (!image || !image.data || image.data.length !== image.width * image.height * 4) return unknown;
    templates ||= ['female', 'male'].map(name => symbolFeatures(decodePng(fs.readFileSync(path.join(__dirname, 'assets/gender', `${name}-badge.png`))))[0]);
    // Compare both contrast polarities; themes can use a dark disc and light symbol.
    const inverted = { ...image, data: new Uint8Array(image.data.length) };
    for (let p = 0; p < image.data.length; p += 4) {
      inverted.data[p] = 255 - image.data[p]; inverted.data[p + 1] = 255 - image.data[p + 1];
      inverted.data[p + 2] = 255 - image.data[p + 2]; inverted.data[p + 3] = image.data[p + 3];
    }
    const features = [...(symbolFeatures(image, roi) || []), ...(symbolFeatures(inverted, roi) || []), ...(symbolFeatures(image, roi, 1) || []), ...(symbolFeatures(inverted, roi, 1) || [])];
    if (!features) return unknown;
    const matches = features.map(grid => templates.map(t => similarity(grid, t)));
    const accepted = matches.map(scores => {
      const idx = scores[0] > scores[1] ? 0 : 1;
      return scores[idx] >= .67 && scores[idx] - scores[1 - idx] >= .12 ? { sex: idx ? '男' : '女', confidence: scores[idx], source: 'gender-symbol' } : null;
    }).filter(Boolean);
    if (!accepted.length || new Set(accepted.map(match => match.sex)).size > 1) return unknown;
    return accepted.sort((a, b) => b.confidence - a.confidence)[0];
  } catch { return unknown; }
}

module.exports = { decodePng, classifyGenderBadge };
