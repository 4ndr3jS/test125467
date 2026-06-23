/**
 * Kage Client-Side Inpainting Module
 * Erases text from manga speech bubbles using Canvas API.
 * Samples the bubble interior color (not surrounding artwork).
 * Exposes `KageInpaint` globally.
 */

(function () {
  "use strict";

  /**
   * Inpaint text regions on a manga image.
   *
   * Strategy for manga: speech bubbles are light-colored (usually white).
   * We sample INSIDE the box to find the bubble's background color,
   * then fill the text region with that color. This preserves artwork
   * outside the bubble and keeps the bubble looking clean.
   *
   * @param {string} imageUrl
   * @param {Array<{x:number, y:number, w:number, h:number}>} boxes
   * @returns {Promise<Blob>}
   */
  async function inpaint(imageUrl, boxes) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";

      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;

        for (const box of boxes) {
          eraseTextInBubble(pixels, canvas.width, canvas.height, box);
        }

        ctx.putImageData(imageData, 0, 0);

        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Failed to create blob"));
        }, "image/png");
      };

      img.onerror = () => reject(new Error("Failed to load image for inpainting"));
      img.src = imageUrl;
    });
  }

  /**
   * Erase text inside a manga speech bubble.
   *
   * 1. Expands the box slightly
   * 2. Samples pixels from the interior edge of the box (10% inset from each side)
   * 3. Finds the dominant light color → bubble background
   * 4. Fills the box with that color, blending at edges with a slight gradient
   */
  function eraseTextInBubble(pixels, imgW, imgH, box) {
    const pad = 4;
    const bx = Math.max(0, Math.floor(box.x) - pad);
    const by = Math.max(0, Math.floor(box.y) - pad);
    const bw = Math.min(imgW - bx, Math.ceil(box.w) + pad * 2);
    const bh = Math.min(imgH - by, Math.ceil(box.h) + pad * 2);

    if (bw <= 0 || bh <= 0) return;

    // 1. Find the bubble background color (interior sample, not exterior)
    const bgColor = findBubbleColor(pixels, imgW, imgH, bx, by, bw, bh);

    // 2. Fill the box with the bubble background, using soft edge blending
    const edgeWidth = Math.min(3, Math.floor(Math.min(bw, bh) * 0.15));

    for (let dy = 0; dy < bh; dy++) {
      for (let dx = 0; dx < bw; dx++) {
        const px = bx + dx;
        const py = by + dy;
        if (px >= imgW || py >= imgH) continue;

        // Calculate blend factor (softer at edges)
        let blend = 1.0;
        if (edgeWidth > 0) {
          const distTop = dy;
          const distBottom = bh - dy - 1;
          const distLeft = dx;
          const distRight = bw - dx - 1;
          const minDist = Math.min(distTop, distBottom, distLeft, distRight);
          blend = Math.min(1.0, minDist / edgeWidth);
        }

        const idx = (py * imgW + px) * 4;
        const origR = pixels[idx];
        const origG = pixels[idx + 1];
        const origB = pixels[idx + 2];

        // Blend original pixel with bubble background color
        pixels[idx]     = Math.round(origR + (bgColor.r - origR) * blend);
        pixels[idx + 1] = Math.round(origG + (bgColor.g - origG) * blend);
        pixels[idx + 2] = Math.round(origB + (bgColor.b - origB) * blend);
      }
    }
  }

  /**
   * Find the dominant light color inside the box → the bubble background.
   * Strategy: sample an inset strip (inner 10-25% borders), collect
   * light-colored pixels (bubble interior, not dark text), return
   * the median color of those light pixels.
   */
  function findBubbleColor(pixels, imgW, imgH, bx, by, bw, bh) {
    const insetX = Math.max(1, Math.floor(bw * 0.10));
    const insetY = Math.max(1, Math.floor(bh * 0.10));

    const colors = [];

    // Sample from the inner border region (top, bottom, left, right strips inside the box)
    // Top inner strip
    for (let x = bx + insetX; x < bx + bw - insetX && x < imgW; x++) {
      for (let y = by + 1; y < by + insetY + 1 && y < imgH; y++) {
        sampleLightPixel(pixels, imgW, x, y, colors);
      }
    }
    // Bottom inner strip
    for (let x = bx + insetX; x < bx + bw - insetX && x < imgW; x++) {
      for (let y = by + bh - insetY - 1; y < by + bh - 1 && y < imgH; y++) {
        sampleLightPixel(pixels, imgW, x, y, colors);
      }
    }
    // Left inner strip
    for (let y = by + insetY; y < by + bh - insetY && y < imgH; y++) {
      for (let x = bx + 1; x < bx + insetX + 1 && x < imgW; x++) {
        sampleLightPixel(pixels, imgW, x, y, colors);
      }
    }
    // Right inner strip
    for (let y = by + insetY; y < by + bh - insetY && y < imgH; y++) {
      for (let x = bx + bw - insetX - 1; x < bx + bw - 1 && x < imgW; x++) {
        sampleLightPixel(pixels, imgW, x, y, colors);
      }
    }

    // If we have light-colored samples, return their median
    if (colors.length > 0) {
      colors.sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));
      const median = colors[Math.floor(colors.length / 2)];
      return median;
    }

    // Fallback: sample ALL interior pixels and take the dominant color
    const histogram = {};
    for (let dy = insetY; dy < bh - insetY; dy++) {
      for (let dx = insetX; dx < bw - insetX; dx++) {
        const idx = ((by + dy) * imgW + (bx + dx)) * 4;
        const key = `${pixels[idx]},${pixels[idx+1]},${pixels[idx+2]}`;
        histogram[key] = (histogram[key] || 0) + 1;
      }
    }

    let bestKey = null;
    let bestCount = 0;
    for (const [key, count] of Object.entries(histogram)) {
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }

    if (bestKey) {
      const [r, g, b] = bestKey.split(",").map(Number);
      return { r, g, b };
    }

    // Absolute fallback: white (most manga bubbles are white)
    return { r: 255, g: 255, b: 255 };
  }

  /**
   * Sample a single light-colored pixel. Only accepts pixels where
   * the channel average is > 180 (light/white bubble interior,
   * excluding dark text strokes).
   */
  function sampleLightPixel(pixels, imgW, x, y, out) {
    if (x < 0 || y < 0 || x >= imgW) return;
    const idx = (y * imgW + x) * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];

    // Only sample light pixels (bubble background, not text)
    const avg = (r + g + b) / 3;
    if (avg > 160) {
      out.push({ r, g, b });
    }
  }

  /**
   * Create a mask image (white rectangles on black) for external inpainting APIs.
   */
  async function createMaskImage(imageWidth, imageHeight, boxes) {
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "white";
    const pad = 4;
    for (const box of boxes) {
      ctx.fillRect(
        Math.max(0, box.x - pad),
        Math.max(0, box.y - pad),
        box.w + pad * 2,
        box.h + pad * 2
      );
    }
    return canvas.toDataURL("image/png");
  }

  window.KageInpaint = { inpaint, createMaskImage };
})();
