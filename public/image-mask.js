export function imagePoint(clientX, clientY, rect, view) {
  return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale };
}

export function paintSegment(mask, width, height, from, to, radius, erase = false) {
  const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius));
  const right = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius));
  const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius));
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const t = length ? Math.max(0, Math.min(1, ((x + 0.5 - from.x) * dx + (y + 0.5 - from.y) * dy) / length)) : 0;
      if ((x + 0.5 - from.x - t * dx) ** 2 + (y + 0.5 - from.y - t * dy) ** 2 <= radius ** 2) mask[y * width + x] = erase ? 0 : 1;
    }
  }
}

export function replayMask(width, height, operations) {
  const mask = new Uint8Array(width * height);
  for (const stroke of operations) {
    if (stroke.clear) mask.fill(0);
    else stroke.points.forEach((point, index) => paintSegment(mask, width, height, stroke.points[Math.max(0, index - 1)], point, stroke.radius, stroke.erase));
  }
  return mask;
}

export function maskPixels(mask, preview = false) {
  const pixels = new Uint8ClampedArray(mask.length * 4);
  mask.forEach((selected, index) => {
    const i = index * 4;
    pixels[i] = preview ? 255 : selected ? 255 : 0;
    pixels[i + 1] = preview ? 65 : pixels[i];
    pixels[i + 2] = preview ? 65 : pixels[i];
    pixels[i + 3] = preview ? selected ? 115 : 0 : 255;
  });
  return pixels;
}
