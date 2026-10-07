export function makeCandles(n = 120, start = 60000, drift = 0) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p * (1 + drift + Math.sin(i / 5) * 0.004);
    out.push({ time: Date.UTC(2026, 0, 1) + i * 3600000, open, high: Math.max(open, p) * 1.002, low: Math.min(open, p) * 0.998, close: p, volume: 100 });
  }
  return out;
}

export function geminiResponse(obj) {
  return async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
  });
}
