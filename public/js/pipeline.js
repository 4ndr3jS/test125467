/**
 * Kage Processing Pipeline v4
 * OCR: manga-ocr (text, Japanese) + OCR.space (text + boxes) + Tesseract.js (fallback)
 * Translation: MyMemory via /api/translate
 * Inpainting: Canvas (bubble interior sampling)
 * Rendering: Canvas text with font overlay
 *
 * Key changes from v3:
 *
 * 1. SINGLE SOURCE OF TRUTH FOR TEXT (Japanese).
 * Previously: 3 engines ran in parallel and their outputs were "frankenstein'd"
 * together — manga-ocr text was assigned to Tesseract boxes by Y position
 * (assignLinesToBoxes), which broke whenever line counts differed even by one.
 * Now: manga-ocr wins outright for Japanese text. Tesseract is only consulted
 * when both server engines fail entirely.
 *
 * 2. OCR.space BOXES ARE USED DIRECTLY.
 * No more piping OCR.space boxes through Tesseract re-labelling. If OCR.space
 * returns boxes we use them. If not, we fall back to Tesseract boxes (with
 * Tesseract text — no cross-engine text→box assignment at all).
 *
 * 3. groupWordsIntoLines THRESHOLDS FIXED.
 * yDist threshold raised from 8px to 15px — accommodates manga's taller
 * character cells and font size variation between bubbles.
 * xGap threshold raised from 25px to 40px — avoids splitting a single line of
 * Japanese into multiple boxes when character spacing is wider than expected.
 * Added a minimum xGap of -15 (was -5) to handle slight right-edge overshoot.
 *
 * 4. assignLinesToBoxes IS REMOVED.
 * It was the primary source of garbled output and had no reliable fallback.
 */

(function () {
 "use strict";

 async function processImage(imageRecord, opts = {}) {
   const { targetLang = "en", sourceLang = "ja", fontStyle = "anime", onProgress = null } = opts;
   const imageId = imageRecord.id;
   const imageUrl = imageRecord.original_url;
   const userId = imageRecord.user_id;

   if (!imageUrl) {
     report(onProgress, "error", "start", "No image URL");
     return { success: false, error: "No image URL" };
   }

   try {
     // ═══ STEP 1: OCR ═══
     report(onProgress, "ocr", "start", "Detecting text…");

     const isJapanese = sourceLang === "ja" || sourceLang === "jpn";

     const promises = [
       callOCRWithBoxes(imageUrl, sourceLang),
       KageOCR.recognize(imageUrl, sourceLang,
         (p) => report(onProgress, "ocr", "start", p.status || "Running local OCR…")),
     ];
     if (isJapanese) {
       promises.push(callTextOnlyOCR(imageUrl, sourceLang));
     }

     const results = await Promise.allSettled(promises);
     const ocrS = results[0];
     const tess = results[1];
     const mOCR = isJapanese ? results[2] : null;

     let text = "";
     let boxes = [];
     const engines = [];

     // ── Decide on TEXT ──
     if (isJapanese && isOK(mOCR) && mOCR.value?.text) {
       text = mOCR.value.text;
       engines.push("manga-ocr");
     }

     if (!text && isOK(ocrS) && ocrS.value?.text && !ocrS.value.error) {
       text = ocrS.value.text;
       engines.push("ocrspace-text");
     }

     if (!text && isOK(tess) && tess.value?.text) {
       text = tess.value.text;
       engines.push("tesseract-text");
     }

     // ── Decide on BOXES ──
     if (isOK(ocrS) && ocrS.value?.boxes?.length && !ocrS.value.error) {
       boxes = ocrS.value.boxes;
       if (!engines.some(e => e.startsWith("ocrspace"))) engines.push("ocrspace-boxes");
     } else if (isOK(tess) && tess.value?.boxes?.length) {
       boxes = tess.value.boxes;
       if (!text) text = tess.value.text || "";
       if (!engines.includes("manga-ocr") && !engines.some(e => e.startsWith("ocrspace-text"))) {
         text = tess.value.text || text;
       }
       engines.push("tesseract-boxes");
     }

     text = text.trim();
     if (!text || !boxes.length) {
       report(onProgress, "ocr", "error", "No text detected");
       await db(imageId, userId, "failed", { error_message: "No text detected" });
       return { success: false, error: "No text detected" };
     }

     boxes = groupWordsIntoLines(boxes);

     if (!engines.includes("manga-ocr")) {
       text = boxes.map(b => b.text || "").filter(Boolean).join("\n");
     }

     report(onProgress, "ocr", "done", `${boxes.length} regions · ${engines.join("+")}`);
     await db(imageId, userId, "ocr_done", { ocr_text: text, boxes: JSON.stringify(boxes) });

     // ═══ STEP 2: Translate ═══
     report(onProgress, "translate", "start", "Translating…");
     const tr = await translate(text, sourceLang, targetLang);
     if (!tr || tr.error) {
       report(onProgress, "translate", "error", tr?.error || "failed");
       await db(imageId, userId, "failed", { error_message: "Translation failed" });
       return { success: false, error: "Translation failed" };
     }
     report(onProgress, "translate", "done", tr.engine || "done");
     await db(imageId, userId, "translating_done", { translated_text: tr.translatedText });

     // ═══ STEP 3: Inpaint ═══
     report(onProgress, "inpaint", "start", "Cleaning bubbles…");
     let cleanedBlob;
     try { cleanedBlob = await KageInpaint.inpaint(imageUrl, boxes); }
     catch (e) {
       report(onProgress, "inpaint", "error", e.message);
       await db(imageId, userId, "failed", { error_message: "Inpaint failed" });
       return { success: false, error: e.message };
     }
     report(onProgress, "inpaint", "done", "Bubbles cleaned");

     let cleanedUrl = imageUrl;
     try {
       const c = KageAuth?.getSupabaseClient?.();
       if (c) {
         const p = `${userId}/cleaned/${imageId}_c.png`;
         await c.storage.from("translated").upload(p, cleanedBlob, { contentType: "image/png", upsert: true });
         cleanedUrl = c.storage.from("translated").getPublicUrl(p).data?.publicUrl || imageUrl;
       }
     } catch (_) { cleanedUrl = URL.createObjectURL(cleanedBlob); }

     await db(imageId, userId, "inpainting_done", { cleaned_url: cleanedUrl });

     // ═══ STEP 4: Render ═══
     report(onProgress, "render", "start", "Rendering text…");
     const rendered = await renderText(cleanedUrl, boxes, tr.translatedText, fontStyle);
     if (!rendered) {
       report(onProgress, "render", "error", "Render failed");
       await db(imageId, userId, "failed", { error_message: "Render failed" });
       return { success: false, error: "Render failed" };
     }
     report(onProgress, "render", "done", "Rendered");

     // ═══ STEP 5: Save ═══
     report(onProgress, "finalize", "start", "Saving…");
     const c = KageAuth?.getSupabaseClient?.();
     if (!c) return { success: false, error: "Not authenticated" };

     const fp = `${userId}/translated/${imageId}_final.png`;
     const { error: ue } = await c.storage.from("translated").upload(fp, rendered, { contentType: "image/png", upsert: true });
     if (ue) { report(onProgress, "finalize", "error", ue.message); return { success: false, error: ue.message }; }

     const finalUrl = c.storage.from("translated").getPublicUrl(fp).data?.publicUrl || "";
     await db(imageId, userId, "completed", { translated_url: finalUrl });
     report(onProgress, "finalize", "done", "Complete!");

     return { success: true, translatedUrl: finalUrl };
   } catch (e) {
     report(onProgress, "error", "error", e.message);
     await db(imageId, userId, "failed", { error_message: e.message });
     return { success: false, error: e.message };
   }
 }

 // ─── API helpers ───

 async function callTextOnlyOCR(url, lang) {
   try {
     const r = await fetch("/api/ocr", {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ imageUrl: url, sourceLang: lang, mode: "text_only" }),
     });
     return await r.json();
   } catch (_) { return null; }
 }

 async function callOCRWithBoxes(url, lang) {
   try {
     const r = await fetch("/api/ocr", {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ imageUrl: url, sourceLang: lang, mode: "full" }),
     });
     return await r.json();
   } catch (_) { return { error: "unreachable" }; }
 }

 async function translate(text, src, tgt) {
   if (src === tgt || (src === "en" && tgt === "en")) return { translatedText: text, engine: "passthrough" };
   try {
     const r = await fetch("/api/translate", {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ text, sourceLang: src, targetLang: tgt }),
     });
     return await r.json();
   } catch (_) { return { error: "unreachable" }; }
 }

 // ─── Box grouping ───

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
     if (!current) {
       current = { ...box };
       continue;
     }

     const yDist = Math.abs((box.y || 0) - (current.y || 0));
     const xGap = (box.x || 0) - ((current.x || 0) + (current.w || 0));

     if (yDist < Y_THRESHOLD && xGap < X_GAP_MAX && xGap > X_GAP_MIN) {
       const newRight = Math.max(
         (current.x || 0) + (current.w || 0),
         (box.x || 0) + (box.w || 0)
       );
       current.w = newRight - (current.x || 0);
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

 function isOK(r) {
   return r && r.status === "fulfilled" && r.value != null;
 }

 // ─── Render ───

 function renderText(imageUrl, boxes, translatedText, fontStyle) {
   return new Promise((resolve) => {
     const img = new Image();
     img.crossOrigin = "anonymous";
     img.onload = () => {
       const c = document.createElement("canvas");
       c.width = img.naturalWidth;
       c.height = img.naturalHeight;
       const ctx = c.getContext("2d");
       ctx.drawImage(img, 0, 0);

       const lines = translatedText.split("\n").filter(Boolean);
       const fonts = {
         anime: "Comic Sans MS, cursive",
         manga: "Impact, sans-serif",
         mincho: "Noto Serif JP, serif",
         gothic: "Noto Sans JP, sans-serif",
         hand: "Bradley Hand, cursive",
         pixel: "Courier New, monospace",
       };
       const ff = fonts[fontStyle] || fonts.anime;

       for (let i = 0; i < Math.min(boxes.length, lines.length); i++) {
         const b = boxes[i];
         const t = lines[i];
         if (!b || !t) continue;

         const fs = fit(ctx, t, b.w || 100, b.h || 30, ff);
         if (fs < 6) continue;

         ctx.save();
         ctx.font = `bold ${fs}px "${ff}"`;
         ctx.textBaseline = "middle";
         ctx.textAlign = "center";
         ctx.strokeStyle = "rgba(0,0,0,0.85)";
         ctx.lineWidth = Math.max(1.5, fs / 16);
         ctx.lineJoin = "round";

         const cx = (b.x || 0) + (b.w || 0) / 2;
         const cy = (b.y || 0) + (b.h || 0) / 2;
         const wl = wrap(ctx, t, (b.w || 100) - 10);
         const lh = fs * 1.35;
         const sy = cy - ((wl.length - 1) * lh) / 2;

         for (let j = 0; j < wl.length; j++) {
           const ly = sy + j * lh;
           ctx.strokeText(wl[j], cx, ly);
           ctx.fillStyle = "white";
           ctx.fillText(wl[j], cx, ly);
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
   const words = text.split(/\s+/);
   const lines = [];
   let cur = "";
   for (const w of words) {
     const t = cur ? cur + " " + w : w;
     if (ctx.measureText(t).width > mw && cur) { lines.push(cur); cur = w; }
     else cur = t;
   }
   if (cur) lines.push(cur);
   if (lines.length === 1 && lines[0].length > 5) {
     const cjk = []; let cl = "";
     for (const ch of lines[0]) {
       if (ctx.measureText(cl + ch).width > mw && cl) { cjk.push(cl); cl = ch; }
       else cl += ch;
     }
     if (cl) cjk.push(cl);
     if (cjk.length > 1) return cjk;
   }
   return lines;
 }

 // ─── DB ───

 async function db(id, uid, status, extra = {}) {
   const c = KageAuth?.getSupabaseClient?.();
   if (!c) return;
   await c.from("images").update({
     status,
     updated_at: new Date().toISOString(),
     ...extra,
   }).eq("id", id).eq("user_id", uid);
 }

 function report(fn, step, status, detail) {
   if (fn) fn(step, status, detail);
 }

 window.KagePipeline = { processImage, renderText };
})();
