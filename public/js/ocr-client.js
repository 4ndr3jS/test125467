/**
 * Kage Client-Side OCR Module (Tesseract.js)
 * Exposes `KageOCR` globally.
 * Simplified: no forced binarisation — clean digital manga doesn't need it.
 */

(function () {
 "use strict";

 let worker = null;
 let jobId = 0;

 async function recognize(imageUrl, sourceLang = "ja", onProgress) {
   const id = ++jobId;

   if (worker) {
     try { await worker.terminate(); } catch (_) {}
     worker = null;
   }

   if (!window.Tesseract) throw new Error("Tesseract missing");

   const langMap = { ja: "jpn", ko: "kor", zh: "chi_sim", "zh-TW": "chi_tra", en: "eng", auto: "jpn+eng" };
   const lang = langMap[sourceLang] || "jpn";

   onProgress?.({ progress: 0, status: "Loading OCR..." });

   const img = await preprocess(imageUrl, id);
   if (!img) throw new Error("Preprocess failed");

   const w = await Tesseract.createWorker(lang, 1, {
     logger: (m) => {
       if (id !== jobId) return;
       if (m.status === "recognizing text") {
         onProgress?.({ progress: 0.1 + m.progress * 0.8, status: "OCR running" });
       }
     },
   });

   worker = w;

   await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });

   const { data } = await w.recognize(img);
   if (id !== jobId) throw new Error("Cancelled");

   const boxes = [];
   let text = "";

   const lines = data.lines || [];
   if (lines.length) {
     for (const l of lines) {
       if (!l.text) continue;
       text += l.text + "\n";
       boxes.push({ x: l.bbox.x0, y: l.bbox.y0, w: l.bbox.x1 - l.bbox.x0, h: l.bbox.y1 - l.bbox.y0, text: l.text });
     }
   } else {
     for (const w of data.words || []) {
       if (!w.text) continue;
       text += w.text + " ";
       boxes.push({ x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0, text: w.text });
     }
   }

   await worker.terminate();
   worker = null;

   onProgress?.({ progress: 1, status: "done" });
   return { text: text.trim(), boxes, confidence: data.confidence };
 }

 function preprocess(url, id) {
   const img = new Image();
   img.crossOrigin = "anonymous";

   return new Promise((resolve) => {
     img.onload = () => {
       if (id !== jobId) return resolve(null);
       const c = document.createElement("canvas");
       c.width = img.naturalWidth;
       c.height = img.naturalHeight;
       const ctx = c.getContext("2d");
       ctx.drawImage(img, 0, 0);
       resolve(c.toDataURL("image/png"));
     };
     img.onerror = () => resolve(null);
     img.src = url;
   });
 }

 async function cancel() {
   jobId++;
   if (worker) { try { await worker.terminate(); } catch (_) {} worker = null; }
 }

 window.KageOCR = { recognize, cancel };
})();
