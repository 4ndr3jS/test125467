/**
 * Kage Client-Side OCR Module (Tesseract.js)
 * Exposes `KageOCR` globally.
 *
 * Changes from original:
 * 1. PSM changed from 11 ("sparse text") to 6 ("uniform block of text").
 * PSM 11 grabs noise, panel borders, and SFX all over the page — wrong for manga.
 * PSM 6 reads clean blocks and respects reading order within each bubble region.
 * 2. Preprocessing is now CONDITIONAL. For clean digital manga/webtoons the source
 * pixels are already anti-aliased; running adaptive thresholding on them destroys
 * the subtle greyscale gradients that Tesseract relies on to find character edges.
 * We detect low-contrast / scanned images automatically and only binarise those.
 * 3. When preprocessing IS applied, the adaptive window shrinks to 11px (was 15) and
 * the C bias rises to 6 (was 4) — this preserves thin strokes better.
 */

(function () {
 "use strict";

 let currentWorker = null;
 let currentJobId = 0;

 async function recognize(imageUrl, sourceLang = "ja", onProgress) {
   const jobId = ++currentJobId;

   if (currentWorker) {
     try { await currentWorker.terminate(); } catch (_) {}
     currentWorker = null;
   }

   if (!window.Tesseract) {
     throw new Error("Tesseract.js not loaded. Add the CDN script to your page.");
   }

   if (onProgress) onProgress({ progress: 0, status: "Analysing image..." });

   const processedDataUrl = await preprocessImage(imageUrl, jobId);
   if (!processedDataUrl) throw new Error("Image pre-processing failed");

   if (onProgress) onProgress({ progress: 0.05, status: "Loading OCR engine..." });

   const langMap = {
     ja: "jpn", ko: "kor", zh: "chi_sim", "zh-TW":"chi_tra",
     en: "eng", fr: "fra", de: "deu", es: "spa", pt: "por", ru: "rus", auto: "jpn+eng",
   };
   const tesseractLang = langMap[sourceLang] || "jpn";

   try {
     const worker = await window.Tesseract.createWorker(tesseractLang, 1, {
       logger: (m) => {
         if (jobId !== currentJobId) return;
         if (m.status === "recognizing text" && onProgress) {
           onProgress({
             progress: Math.min(0.9, 0.05 + m.progress * 0.85),
             status: `OCR… ${Math.round(m.progress * 100)}%`,
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

     await worker.setParameters({
       tessedit_pageseg_mode: "6",
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
           fullText += text + " ";
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

 function needsPreprocessing(gray, width, height) {
   const GRID = 16;
   const stepX = Math.max(1, Math.floor(width / GRID));
   const stepY = Math.max(1, Math.floor(height / GRID));

   let sum = 0, count = 0;
   for (let y = 0; y < height; y += stepY) {
     for (let x = 0; x < width; x += stepX) {
       sum += gray[y * width + x];
       count++;
     }
   }
   const mean = sum / count;

   let variance = 0;
   for (let y = 0; y < height; y += stepY) {
     for (let x = 0; x < width; x += stepX) {
       const d = gray[y * width + x] - mean;
       variance += d * d;
     }
   }
   variance /= count;
   const stddev = Math.sqrt(variance);

   return stddev < 80;
 }

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
       ctx.drawImage(img, 0, 0);

       const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
       const pixels = imageData.data;
       const len = pixels.length;
       const w = canvas.width;
       const h = canvas.height;

       const gray = new Uint8Array(w * h);
       for (let i = 0; i < len; i += 4) {
         gray[i >> 2] = Math.round(pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114);
       }

       if (!needsPreprocessing(gray, w, h)) {
         resolve(canvas.toDataURL("image/png"));
         return;
       }

       let min = 255, max = 0;
       for (let i = 0; i < gray.length; i++) {
         if (gray[i] < min) min = gray[i];
         if (gray[i] > max) max = gray[i];
       }
       const range = max - min || 1;
       const cmap = new Uint8Array(256);
       for (let i = 0; i < 256; i++) {
         cmap[i] = Math.round(((i - min) / range) * 255);
       }

       const windowSize = 11;
       const half = Math.floor(windowSize / 2);
       const C = 6;

       const integral = new Uint32Array((w + 1) * (h + 1));
       for (let y = 0; y < h; y++) {
         let rowSum = 0;
         for (let x = 0; x < w; x++) {
           rowSum += cmap[gray[y * w + x]];
           integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
         }
       }

       for (let y = 0; y < h; y++) {
         for (let x = 0; x < w; x++) {
           const x1 = Math.max(0, x - half);
           const y1 = Math.max(0, y - half);
           const x2 = Math.min(w - 1, x + half);
           const y2 = Math.min(h - 1, y + half);

           const area = (x2 - x1 + 1) * (y2 - y1 + 1);
           const sum =
             integral[(y2 + 1) * (w + 1) + (x2 + 1)] -
             integral[(y2 + 1) * (w + 1) + x1] -
             integral[y1 * (w + 1) + (x2 + 1)] +
             integral[y1 * (w + 1) + x1];

           const localMean = sum / area;
           const pixelVal = cmap[gray[y * w + x]];
           const binary = pixelVal < (localMean - C) ? 0 : 255;

           const i4 = (y * w + x) * 4;
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
