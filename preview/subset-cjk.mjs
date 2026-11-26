import fs from 'node:fs';
import * as r from 'restructure';
import * as fontkit from 'fontkit';

const fontUrl = new URL(
  '../test/data/NotoSansCJK/NotoSansCJKkr-Regular.otf',
  import.meta.url,
);
const outputSvgUrl = new URL('./u4e00.svg', import.meta.url);
const outputOriginalSvgUrl = new URL('./u4e00-original.svg', import.meta.url);

const firstCodePoint = 0x4e00;
const lastCodePoint = 0x5d9f;

// Opening/parsing table directories happens before the measured subset step.
const font = fontkit.openSync(fontUrl);
const CFFFont = font['CFF '].constructor;
const CFFGlyph = font.glyphForCodePoint(firstCodePoint).constructor;

function svgForPath(path) {
  const d = path.toSVG();
  const box = path.bbox;
  const w = Math.max(1, Math.ceil(box.maxX - box.minX));
  const h = Math.max(1, Math.ceil(box.maxY - box.minY));
  return {
    d,
    box,
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.minX} ${-box.maxY} ${w} ${h}" width="480" height="480">
  <rect x="${box.minX}" y="${-box.maxY}" width="${w}" height="${h}" fill="#111"/>
  <path d="${d}" transform="scale(1,-1)" fill="#f4f1ea"/>
</svg>
`,
  };
}

// One subsetting pass per process. The timer starts before collecting glyphs.
const start = performance.now();
const subset = font.createSubset();
for (let codePoint = firstCodePoint; codePoint <= lastCodePoint; codePoint++) {
  subset.includeGlyph(font.glyphForCodePoint(codePoint));
}
const buffer = subset.encode();
const milliseconds = performance.now() - start;

// Decode the produced CFF table and compare every requested outline after the
// timed region. Glyph 0 is .notdef, so the first page character is glyph 1.
const cff = new CFFFont(new r.DecodeStream(buffer));
let firstOutline = null;
let firstBox = null;
let checked = 0;

for (let codePoint = firstCodePoint; codePoint <= lastCodePoint; codePoint++) {
  const subsetGlyphId = codePoint - firstCodePoint + 1;
  const subsetGlyph = new CFFGlyph(subsetGlyphId, [], { 'CFF ': cff });
  const originalGlyph = font.glyphForCodePoint(codePoint);

  const subsetPath = subsetGlyph.path;
  const originalPath = originalGlyph.path;
  const subsetD = subsetPath.toSVG();
  const originalD = originalPath.toSVG();

  if (subsetD !== originalD) {
    throw new Error(
      `Outline mismatch at U+${codePoint.toString(16).toUpperCase()}`,
    );
  }

  if (
    subsetPath.bbox.minX !== originalPath.bbox.minX ||
    subsetPath.bbox.minY !== originalPath.bbox.minY ||
    subsetPath.bbox.maxX !== originalPath.bbox.maxX ||
    subsetPath.bbox.maxY !== originalPath.bbox.maxY
  ) {
    throw new Error(
      `Bounds mismatch at U+${codePoint.toString(16).toUpperCase()}`,
    );
  }

  if (codePoint === firstCodePoint) {
    firstOutline = svgForPath(subsetPath);
    const originalPreview = svgForPath(originalPath);
    firstBox = subsetPath.bbox;
    fs.writeFileSync(outputOriginalSvgUrl, originalPreview.svg);
  }

  checked++;
}

fs.writeFileSync(outputSvgUrl, firstOutline.svg);

const result = {
  milliseconds: Math.round(milliseconds),
  bytes: buffer.length,
  glyphs: subset.glyphs.length,
  checked,
  firstCodePoint: 'U+4E00',
  firstPath: firstOutline.d,
  bbox: {
    minX: firstBox.minX,
    minY: firstBox.minY,
    maxX: firstBox.maxX,
    maxY: firstBox.maxY,
  },
  preview: 'preview/u4e00.svg',
};

console.log(JSON.stringify(result, null, 2));
console.log(
  `${Math.round(milliseconds)} ms, ${buffer.length} bytes; U+4E00 preview wrote preview/u4e00.svg`,
);
