const DCT_COS = Array.from({ length: 32 }, (_, k) =>
  Float64Array.from({ length: 32 }, (_, n) => Math.cos((Math.PI * (2 * n + 1) * k) / 64))
);

self.onmessage = async (e) => {
  const { id, file } = e.data;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = 32;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, size, size);
    bitmap.close();
    const data = ctx.getImageData(0, 0, size, size).data;

    // Grayscale
    const gray = new Float64Array(size * size);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }

    // 2D DCT (separable)
    const dct = new Float64Array(size * size);
    const tmp = new Float64Array(size * size);
    // rows
    for (let y = 0; y < size; y++) {
      const row = gray.subarray(y * size, (y + 1) * size);
      const out = dct1d(row, size);
      tmp.set(out, y * size);
    }
    // columns
    for (let x = 0; x < size; x++) {
      const col = new Float64Array(size);
      for (let y = 0; y < size; y++) col[y] = tmp[y * size + x];
      const out = dct1d(col, size);
      for (let y = 0; y < size; y++) dct[y * size + x] = out[y];
    }

    // Top-left 8x8 (excluding none) -> 64 values
    const vals = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        vals.push(dct[y * size + x]);
      }
    }
    // Median
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const hash = vals.map(v => (v >= median ? '1' : '0')).join('');
    self.postMessage({ id, hash });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

function dct1d(input, N) {
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * DCT_COS[k][n];
    }
    const alpha = k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
    out[k] = sum * alpha;
  }
  return out;
}
