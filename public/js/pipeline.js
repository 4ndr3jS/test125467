/**
 * Kage Processing Pipeline v5
 * Simplified: single source of truth, no cross-engine text→box mixing.
 */

(function () {
 "use strict";

 async function processImage(imageRecord, opts = {}) {
   const { targetLang = "en", sourceLang = "ja", fontStyle = "anime", onProgress } = opts;
   const { id, original_url: url, user_id } = imageRecord;
   if (!url) return fail(onProgress, "No image URL");

   try {
     report(onProgress, "ocr", "start", "OCR running");

     const isJP = sourceLang === "ja";

     const [ocrS, tess, manga] = await Promise.allSettled([
       callOCR(url, sourceLang),
       KageOCR.recognize(url, sourceLang),
       isJP ? callMangaOCR(url, sourceLang) : Promise.resolve(null),
     ]);

     let text = "";
     let boxes = [];
     const engines = [];

     if (isJP && ok(manga) && manga.value?.text) { text = manga.value.text; engines.push("manga"); }
     if (!text && ok(ocrS) && ocrS.value?.text) { text = ocrS.value.text; engines.push("ocrspace"); }
     if (!text && ok(tess) && tess.value?.text) { text = tess.value.text; engines.push("tesseract"); }

     if (ok(ocrS) && ocrS.value?.boxes?.length) {
       boxes = ocrS.value.boxes;
     } else if (ok(tess) && tess.value?.boxes?.length) {
       boxes = tess.value.boxes;
     }

     if (!text || !boxes.length) return fail(onProgress, "No text found");

     boxes = groupWordsIntoLines(boxes);

     if (!engines.includes("manga")) {
       text = boxes.map(b => b.text).join("\n");
     }

     report(onProgress, "translate", "start", "Translating");
     const tr = await translate(text, sourceLang, targetLang);
     if (!tr?.translatedText) return fail(onProgress, "Translation failed");

     report(onProgress, "inpaint", "start", "Cleaning");
     const cleaned = await KageInpaint.inpaint(url, boxes);

     const rendered = await renderText(cleaned, boxes, tr.translatedText, fontStyle);

     const finalUrl = await save(rendered, id, user_id);

     report(onProgress, "final", "done", "Complete");
     return { success: true, translatedUrl: finalUrl };
   } catch (e) {
     return fail(onProgress, e.message);
   }
 }

 function groupWordsIntoLines(boxes) {
   if (!boxes.length) return boxes;

   const Y_THRESHOLD = 15;
   const X_GAP_MAX = 40;
   const X_GAP_MIN = -15;

   const sorted = [...boxes].sort((a, b) => {
     const yDiff = (a.y || 0) - (b.y || 0);
     if (Math.abs(yDiff) < Y_THRESHOLD) return (a.x || 0) - (b.x || 0);
     return yDiff;
   });

   const lines = [];
   let current = null;

   for (const box of sorted) {
     if (!current) { current = { ...box }; continue; }

     const yDist = Math.abs((box.y || 0) - (current.y || 0));
     const xGap = (box.x || 0) - ((current.x || 0) + (current.w || 0));

     if (yDist < Y_THRESHOLD && xGap < X_GAP_MAX && xGap > X_GAP_MIN) {
       const nr = Math.max((current.x || 0) + (current.w || 0), (box.x || 0) + (box.w || 0));
       current.w = nr - (current.x || 0);
       current.h = Math.max(current.h || 0, box.h || 0);
       current.y = Math.min(current.y || 0, box.y || 0);
       current.text = (current.text || "") + " " + (box.text || "");
     } else {
       lines.push(current);
       current = { ...box };
     }
   }
   if (current) lines.push(current);
   return lines;
 }

 async function callOCR(url, lang) {
   const r = await fetch("/api/ocr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl: url, sourceLang: lang, mode: "full" }) });
   return r.json();
 }

 async function callMangaOCR(url, lang) {
   const r = await fetch("/api/ocr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl: url, sourceLang: lang, mode: "text_only" }) });
   return r.json();
 }

 async function translate(text, src, tgt) {
   if (src === tgt) return { translatedText: text };
   const r = await fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sourceLang: src, targetLang: tgt }) });
   return r.json();
 }

 function renderText(imageUrl, boxes, translatedText, fontStyle) {
   return new Promise((resolve) => {
     const img = new Image();
     img.crossOrigin = "anonymous";
     img.onload = () => {
       const c = document.createElement("canvas");
       c.width = img.naturalWidth; c.height = img.naturalHeight;
       const ctx = c.getContext("2d");
       ctx.drawImage(img, 0, 0);

       const lines = translatedText.split("\n").filter(Boolean);
       const fonts = { anime: "Comic Sans MS, cursive", manga: "Impact, sans-serif", mincho: "Noto Serif JP, serif", gothic: "Noto Sans JP, sans-serif", hand: "Bradley Hand, cursive", pixel: "Courier New, monospace" };
       const ff = fonts[fontStyle] || fonts.anime;

       for (let i = 0; i < Math.min(boxes.length, lines.length); i++) {
         const b = boxes[i], t = lines[i];
         if (!b || !t) continue;

         const fs = fit(ctx, t, b.w || 100, b.h || 30, ff);
         if (fs < 6) continue;

         ctx.save();
         ctx.font = `bold ${fs}px "${ff}"`;
         ctx.textBaseline = "middle"; ctx.textAlign = "center";
         ctx.strokeStyle = "rgba(0,0,0,0.85)";
         ctx.lineWidth = Math.max(1.5, fs / 16); ctx.lineJoin = "round";

         const cx = (b.x || 0) + (b.w || 0) / 2;
         const cy = (b.y || 0) + (b.h || 0) / 2;
         const wl = wrap(ctx, t, (b.w || 100) - 10);
         const lh = fs * 1.35;
         const sy = cy - ((wl.length - 1) * lh) / 2;

         for (let j = 0; j < wl.length; j++) {
           const ly = sy + j * lh;
           ctx.strokeText(wl[j], cx, ly);
           ctx.fillStyle = "white"; ctx.fillText(wl[j], cx, ly);
         }
         ctx.restore();
       }
       c.toBlob((blob) => resolve(blob), "image/png");
     };
     img.onerror = () => resolve(null);
     img.src = imageUrl;
   });
 }

 function fit(ctx, text, mw, mh, ff) {
   let fs = Math.min(mh * 0.55, 32);
   while (fs > 7) {
     ctx.font = `bold ${fs}px "${ff}"`;
     if (wrap(ctx, text, mw - 12).length * fs * 1.35 <= mh * 0.85) break;
     fs--;
   }
   return Math.max(7, Math.round(fs));
 }

 function wrap(ctx, text, mw) {
   const words = text.split(/\s+/); const lines = []; let cur = "";
   for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > mw && cur) { lines.push(cur); cur = w; } else cur = t; }
   if (cur) lines.push(cur);
   if (lines.length === 1 && lines[0].length > 5) {
     const cjk = []; let cl = "";
     for (const ch of lines[0]) { if (ctx.measureText(cl + ch).width > mw && cl) { cjk.push(cl); cl = ch; } else cl += ch; }
     if (cl) cjk.push(cl);
     if (cjk.length > 1) return cjk;
   }
   return lines;
 }

 function ok(r) { return r.status === "fulfilled"; }
 function report(fn, s, st, d) { fn?.(s, st, d); }
 function fail(fn, msg) { report(fn, "error", "error", msg); return { success: false, error: msg }; }

 async function save(blob, id, uid) {
   const c = KageAuth?.getSupabaseClient?.();
   if (!c) return null;
   const path = `${uid}/translated/${id}.png`;
   await c.storage.from("translated").upload(path, blob, { upsert: true });
   return c.storage.from("translated").getPublicUrl(path).data.publicUrl;
 }

 window.KagePipeline = { processImage, renderText };
})();
