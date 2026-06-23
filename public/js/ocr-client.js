/**
 * Kage Client-Side OCR Module (Tesseract.js)
 * Includes image pre-processing for better manga text detection.
 * Exposes `KageOCR` globally.
 */

(function () {
  "use strict";

  let currentWorker = null;
  let currentJobId = 0;

  /**
   * Run OCR on an image with pre-processing for manga text.
   */
  async function recognize(imageUrl, sourceLang = "ja", onProgress) {
    const jobId = ++currentJobId;

    if (currentWorker) {
      try { await currentWorker.terminate(); } catch (_) {}
      currentWorker = null;
    }

    if (!window.Tesseract) {
      throw new Error("Tesseract.js not loaded. Add the CDN script to your page.");
    }

    if (onProgress) onProgress({ progress: 0, status: "Pre-processing image..." });

    // Step 1: Pre-process the image for better OCR
    const processedDataUrl = await preprocessImage(imageUrl, jobId);
    if (!processedDataUrl) throw new Error("Image pre-processing failed");

    if (onProgress) onProgress({ progress: 0.05, status: "Loading OCR engine..." });

    // Language mapping
    const langMap = {
      ja: "jpn",
      ko: "kor",
      zh: "chi_sim",
      "zh-TW": "chi_tra",
      en: "eng",
      fr: "fra",
      de: "deu",
      es: "spa",
      pt: "por",
      ru: "rus",
      auto: "jpn+eng",
    };

    const tesseractLang = langMap[sourceLang] || "jpn";

    try {
      const worker = await window.Tesseract.createWorker(tesseractLang, 1, {
        logger: (m) => {
          if (jobId !== currentJobId) return;
          if (m.status === "recognizing text" && onProgress) {
            onProgress({
              progress: Math.min(0.9, 0.05 + m.progress * 0.85),
              status: `OCR... ${Math.round(m.progress * 100)}%`,
            });
          }
        },
      });

      currentWorker = worker;
      if (jobId !== currentJobId) {
        await worker.terminate();
        currentWorker = null;
        throw new Error("Cancelled");
      }

      // Set Tesseract parameters optimized for manga
      await worker.setParameters({
        tessedit_pageseg_mode: "11",    // Sparse text — find as much as possible
        tessedit_char_whitelist: "",
        preserve_interword_spaces: "1",
      });

      if (onProgress) onProgress({ progress: 0.08, status: "Running OCR..." });

      const { data } = await worker.recognize(processedDataUrl);

      if (jobId !== currentJobId) {
        await worker.terminate();
        currentWorker = null;
        throw new Error("Cancelled");
      }

      // Normalize output
      let fullText = "";
      const boxes = [];

      if (data.lines && data.lines.length > 0) {
        for (const line of data.lines) {
          const text = line.text.trim();
          if (text) {
            fullText += text + "\n";
            boxes.push({
              x: line.bbox.x0,
              y: line.bbox.y0,
              w: line.bbox.x1 - line.bbox.x0,
              h: line.bbox.y1 - line.bbox.y0,
              text,
            });
          }
        }
      } else if (data.words && data.words.length > 0) {
        for (const word of data.words) {
          const text = word.text.trim();
          if (text) {
            fullText += text;
            boxes.push({
              x: word.bbox.x0,
              y: word.bbox.y0,
              w: word.bbox.x1 - word.bbox.x0,
              h: word.bbox.y1 - word.bbox.y0,
              text,
            });
          }
        }
        fullText = fullText.trim();
      } else if (data.text) {
        fullText = data.text.trim();
      }

      await worker.terminate();
      currentWorker = null;

      if (onProgress) onProgress({ progress: 1, status: "OCR complete" });

      return { text: fullText.trim(), boxes, confidence: data.confidence };
    } catch (err) {
      if (currentWorker) {
        try { await currentWorker.terminate(); } catch (_) {}
        currentWorker = null;
      }
      throw err;
    }
  }

  /**
   * Pre-process image for better OCR:
   * 1. Convert to grayscale
   * 2. Increase contrast using CLAHE-like approach
   * 3. Apply adaptive thresholding for binarization
   * 4. Sharpen edges
   * Returns a data URL of the processed image.
   */
  function preprocessImage(imageUrl, jobId) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";

      img.onload = () => {
        if (jobId !== currentJobId) return resolve(null);

        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");

        // Draw original
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;
        const len = pixels.length;

        // --- Step 1: Convert to grayscale ---
        const gray = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < len; i += 4) {
          // Weighted grayscale (luminance)
          gray[i / 4] = Math.round(
            pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114
          );
        }

        // --- Step 2: Contrast enhancement (stretch histogram) ---
        let min = 255, max = 0;
        for (let i = 0; i < gray.length; i++) {
          if (gray[i] < min) min = gray[i];
          if (gray[i] > max) max = gray[i];
        }
        const range = max - min || 1;
        const contrastMap = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
          contrastMap[i] = Math.round(((i - min) / range) * 255);
        }

        // --- Step 3: Adaptive thresholding ---
        // Use adaptive thresholding — smaller window preserves small text
        const windowSize = 15; // Smaller = more text preserved
        const halfWindow = Math.floor(windowSize / 2);
        const w = canvas.width;
        const h = canvas.height;

        // Compute integral image for fast local sum
        const integral = new Uint32Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y++) {
          let rowSum = 0;
          for (let x = 0; x < w; x++) {
            const val = contrastMap[gray[y * w + x]];
            rowSum += val;
            const above = integral[y * (w + 1) + (x + 1)];
            integral[(y + 1) * (w + 1) + (x + 1)] = above + rowSum;
          }
        }

        const C = 4; // Lower = more text preserved (less aggressive removal)

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const x1 = Math.max(0, x - halfWindow);
            const y1 = Math.max(0, y - halfWindow);
            const x2 = Math.min(w - 1, x + halfWindow);
            const y2 = Math.min(h - 1, y + halfWindow);

            const area = (x2 - x1 + 1) * (y2 - y1 + 1);
            const sum =
              integral[(y2 + 1) * (w + 1) + (x2 + 1)] -
              integral[(y2 + 1) * (w + 1) + x1] -
              integral[y1 * (w + 1) + (x2 + 1)] +
              integral[y1 * (w + 1) + x1];

            const mean = sum / area;
            const idx = y * w + x;
            const pixelVal = contrastMap[gray[idx]];

            // If pixel is darker than local mean, it's text (black)
            const binary = pixelVal < (mean - C) ? 0 : 255;

            const i4 = idx * 4;
            pixels[i4] = binary;
            pixels[i4 + 1] = binary;
            pixels[i4 + 2] = binary;
            pixels[i4 + 3] = 255;
          }
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      };

      img.onerror = () => resolve(null);
      img.src = imageUrl;
    });
  }

  async function cancel() {
    currentJobId++;
    if (currentWorker) {
      try { await currentWorker.terminate(); } catch (_) {}
      currentWorker = null;
    }
  }

  window.KageOCR = { recognize, cancel };
})();
