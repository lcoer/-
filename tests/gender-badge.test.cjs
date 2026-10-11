const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodePng, classifyGenderBadge } = require('../src/gender-badge.cjs');
const fixture = sex => fs.readFileSync(path.join(__dirname, '../src/assets/gender', `${sex}-badge.png`));
test('recognizes supplied gender symbols, independently of age text', () => {
  for (const [name, sex] of [['female', '女'], ['male', '男']]) {
    const pixels = decodePng(fixture(name));
    assert.equal(classifyGenderBadge(pixels).sex, sex);
    for (let y = 0; y < pixels.height; y++) for (let x = Math.ceil(pixels.width * .55); x < pixels.width; x++) {
      const p = (y * pixels.width + x) * 4;
      pixels.data[p] = 255; pixels.data[p + 1] = 0; pixels.data[p + 2] = 255;
    }
    assert.equal(classifyGenderBadge(pixels).sex, sex);
  }
});
test('blank, grayscale and unrelated colored circles remain unknown', () => {
  const pixels = decodePng(fixture('male'));
  for (let p = 0; p < pixels.data.length; p += 4) {
    const v = Math.round((pixels.data[p] + pixels.data[p + 1] + pixels.data[p + 2]) / 3);
    pixels.data[p] = pixels.data[p + 1] = pixels.data[p + 2] = v;
  }
  assert.equal(classifyGenderBadge(pixels).sex, '未知');
  pixels.data.fill(0);
  assert.equal(classifyGenderBadge(pixels).sex, '未知');
  const circle = { width: 30, height: 30, data: new Uint8Array(3600) };
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
    const p = (y * 30 + x) * 4, v = (x - 15) ** 2 + (y - 15) ** 2 < 100 ? 200 : 70;
    circle.data[p] = v; circle.data[p + 1] = v; circle.data[p + 2] = v + 20; circle.data[p + 3] = 255;
  }
  assert.equal(classifyGenderBadge(circle).sex, '未知');
});
function resize(image, scale) {
  const width = Math.round(image.width * scale), height = Math.round(image.height * scale), data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4, q = (Math.min(image.height - 1, Math.floor(y / scale)) * image.width + Math.min(image.width - 1, Math.floor(x / scale))) * 4;
    data.set(image.data.subarray(q, q + 4), p);
  }
  return { width, height, data };
}
test('symbol shape survives scaling and changed badge color', () => {
  for (const [name, sex] of [['female', '女'], ['male', '男']]) {
    const pixels = decodePng(fixture(name));
    for (let p = 0; p < pixels.data.length; p += 4) {
      const l = pixels.data[p] * .299 + pixels.data[p + 1] * .587 + pixels.data[p + 2] * .114;
      pixels.data[p] = Math.round(l * .75); pixels.data[p + 1] = Math.round(l * .75 + 15); pixels.data[p + 2] = Math.round(l * .75 + 30);
    }
    for (const scale of [1, 1.5, 2, 3]) assert.equal(classifyGenderBadge(resize(pixels, scale)).sex, sex, `${name} at ${scale}`);
  }
});
test('two conflicting symbols cannot assign a gender', () => {
  const a = decodePng(fixture('female')), b = decodePng(fixture('male'));
  const width = Math.max(a.width, b.width);
  const image = { width, height: a.height + b.height + 10, data: new Uint8Array(width * (a.height + b.height + 10) * 4) };
  for (const [pixels, offset] of [[a, 0], [b, a.height + 10]]) for (let y = 0; y < pixels.height; y++) {
    image.data.set(pixels.data.subarray(y * pixels.width * 4, (y + 1) * pixels.width * 4), (offset + y) * image.width * 4);
  }
  assert.equal(classifyGenderBadge(image).sex, '未知');
});
test('malformed images and out of bounds ROIs fail closed', () => {
  assert.equal(classifyGenderBadge(Buffer.from('not png')).sex, '未知');
  assert.equal(classifyGenderBadge(decodePng(fixture('male')), { x: -1, y: 0, width: 10, height: 10 }).sex, '未知');
});
test('an explicit icon-only ROI excludes adjacent age and other page controls', () => {
  assert.equal(classifyGenderBadge(decodePng(fixture('male')), { x: 2, y: 10, width: 25, height: 25 }).sex, '男');
  assert.equal(classifyGenderBadge(decodePng(fixture('female')), { x: 7, y: 2, width: 18, height: 17 }).sex, '女');
});

test('recognizes low contrast and reversed light symbols in shifted badge ROIs', () => {
  for (const [name, sex] of [['female', '\u5973'], ['male', '\u7537']]) {
    for (const invert of [false, true]) {
      const icon = decodePng(fixture(name));
      for (let p = 0; p < icon.data.length; p += 4) {
        const l = icon.data[p] * .299 + icon.data[p + 1] * .587 + icon.data[p + 2] * .114;
        const v = Math.round(100 + (invert ? 255 - l : l) * .16);
        icon.data[p] = v; icon.data[p + 1] = v + 12; icon.data[p + 2] = v + 24;
      }
      const width = icon.width + 24, height = icon.height + 8;
      const shifted = { width, height, data: new Uint8Array(width * height * 4) };
      for (let p = 0; p < shifted.data.length; p += 4) shifted.data.set([100,112,124,255],p);
      for (let y=0;y<icon.height;y++) shifted.data.set(icon.data.subarray(y*icon.width*4,(y+1)*icon.width*4),((y+4)*width+20)*4);
      assert.equal(classifyGenderBadge(shifted).sex, sex, name + ' invert=' + invert);
    }
  }
});

test('age-only crops and unrelated plus symbols cannot identify gender', () => {
  for (const name of ['female','male']) {
    const image = decodePng(fixture(name));
    assert.equal(classifyGenderBadge(image, { x: Math.ceil(image.width * .6), y: 0, width: Math.floor(image.width * .4), height: image.height }).sex, '\u672a\u77e5');
  }
  const image={width:30,height:30,data:new Uint8Array(3600)};
  for(let y=0;y<30;y++) for(let x=0;x<30;x++) {
    const p=(y*30+x)*4, disc=(x-15)**2+(y-15)**2<121;
    const plus=disc && ((Math.abs(x-15)<2 && y>7 && y<23) || (Math.abs(y-15)<2 && x>7 && x<23));
    const v=disc&&!plus?210:70; image.data.set([v,v+10,v+20,255],p);
  }
  assert.equal(classifyGenderBadge(image).sex, '\u672a\u77e5');
});
