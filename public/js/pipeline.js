/**
 * Kage Processing Pipeline v3
 * OCR: HF Space manga-ocr + OCR.space + Tesseract.js (all three in parallel)
 * Translation: MyMemory via /api/translate
 * Inpainting: Canvas (bubble interior sampling)
 * Rendering: Canvas text with font overlay
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
      // ═══ STEP 1: OCR (3 engines in parallel) ═══
      report(onProgress, "ocr", "start", "Detecting text...");

      const [mOCR, ocrS, tess] = await Promise.allSettled([
        callTextOnlyOCR(imageUrl, sourceLang),
        callOCRWithBoxes(imageUrl, sourceLang),
        KageOCR.recognize(imageUrl, sourceLang, (p) =>
          report(onProgress, "ocr", "start", p.status || "Running local OCR...")
        ),
      ]);

      let text = "", boxes = [], engines = [];

      // HF Space manga-ocr — only use for Japanese (otherwise returns garbled)
      const isJapanese = sourceLang === "ja" || sourceLang === "jpn";
      if (isOK(mOCR) && mOCR.value?.text && isJapanese) {
        text = mOCR.value.text;
        engines.push("manga-ocr-space");
      }

      // OCR.space (text + boxes)
      if (isOK(ocrS) && ocrS.value && !ocrS.value.error) {
        if (ocrS.value.boxes?.length) boxes = ocrS.value.boxes;
        if (!text && ocrS.value.text) text = ocrS.value.text;
        if (!engines.includes("manga-ocr-space")) engines.push("ocrspace");
      }

      // Tesseract.js (boxes + fallback text)
      if (isOK(tess) && tess.value?.boxes?.length) {
        if (!boxes.length) {
          boxes = tess.value.boxes;
          // Assign manga-ocr text to Tesseract boxes by Y position
          if (mOCR.value?.lines && isJapanese) boxes = assignLinesToBoxes(mOCR.value.lines, boxes);
        } else {
          for (const b of tess.value.boxes)
            if (b.text?.trim() && !boxes.some((e) => overlap(e, b))) boxes.push(b);
        }
        if (!text) { text = tess.value.text; engines.push("tesseract-text"); }
        else engines.push("tesseract-boxes");
      }

      text = text.trim();
      if (!text || !boxes.length) {
        report(onProgress, "ocr", "error", "No text detected");
        await db(imageId, userId, "failed", { error_message: "No text detected" });
        return { success: false, error: "No text detected" };
      }

      // Group word-level boxes into line-level boxes for better rendering
      const grouped = groupWordsIntoLines(boxes);
      boxes = grouped;
      // Regenerate text from grouped boxes for cleaner translation
      text = grouped.map(b => b.text || "").filter(Boolean).join("\n");

      report(onProgress, "ocr", "done", `${boxes.length} regions · ${engines.join("+")}`);
      await db(imageId, userId, "ocr_done", { ocr_text: text, boxes: JSON.stringify(boxes) });

      // ═══ STEP 2: Translate ═══
      report(onProgress, "translate", "start", "Translating...");
      const tr = await translate(text, sourceLang, targetLang);
      if (!tr || tr.error) {
        report(onProgress, "translate", "error", tr?.error || "failed");
        await db(imageId, userId, "failed", { error_message: "Translation failed" });
        return { success: false, error: "Translation failed" };
      }
      report(onProgress, "translate", "done", tr.engine || "done");
      await db(imageId, userId, "translating_done", { translated_text: tr.translatedText });

      // ═══ STEP 3: Inpaint ═══
      report(onProgress, "inpaint", "start", "Cleaning bubbles...");
      let cleanedBlob;
      try { cleanedBlob = await KageInpaint.inpaint(imageUrl, boxes); }
      catch (e) {
        report(onProgress, "inpaint", "error", e.message);
        await db(imageId, userId, "failed", { error_message: "Inpaint failed" });
        return { success: false, error: e.message };
      }
      report(onProgress, "inpaint", "done", "Bubbles cleaned");

      // Upload cleaned image
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
      report(onProgress, "render", "start", "Rendering text...");
      const rendered = await renderText(cleanedUrl, boxes, tr.translatedText, fontStyle);
      if (!rendered) {
        report(onProgress, "render", "error", "Render failed");
        await db(imageId, userId, "failed", { error_message: "Render failed" });
        return { success: false, error: "Render failed" };
      }
      report(onProgress, "render", "done", "Rendered");

      // ═══ STEP 5: Save ═══
      report(onProgress, "finalize", "start", "Saving...");
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
      const r = await fetch("/api/ocr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl: url, sourceLang: lang, mode: "text_only" }) });
      return await r.json();
    } catch (_) { return null; }
  }

  async function callOCRWithBoxes(url, lang) {
    try {
      const r = await fetch("/api/ocr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl: url, sourceLang: lang, mode: "full" }) });
      return await r.json();
    } catch (_) { return { error: "unreachable" }; }
  }

  async function translate(text, src, tgt) {
    if (src === tgt || (src === "en" && tgt === "en")) return { translatedText: text, engine: "passthrough" };
    try {
      const r = await fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sourceLang: src, targetLang: tgt }) });
      return await r.json();
    } catch (_) { return { error: "unreachable" }; }
  }

  // ─── Box math ───

  function overlap(a, b) {
    const ax1 = a.x || 0, ay1 = a.y || 0, ax2 = ax1 + (a.w || 50), ay2 = ay1 + (a.h || 20);
    const bx1 = b.x || 0, by1 = b.y || 0, bx2 = bx1 + (b.w || 50), by2 = by1 + (b.h || 20);
    const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1), ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
    if (ix1 >= ix2 || iy1 >= iy2) return false;
    const iArea = (ix2 - ix1) * (iy2 - iy1);
    return (iArea / Math.min((ax2 - ax1) * (ay2 - ay1), (bx2 - bx1) * (by2 - by1))) > 0.3;
  }

  /**
   * Group word-level boxes into line-level boxes.
   * OCR.space returns per-word boxes; this merges adjacent words on the same row
   * into a single wider box, so translated text has room to fit.
   */
  function groupWordsIntoLines(boxes) {
    if (!boxes.length) return boxes;
    
    // Sort by Y position (top to bottom), then X (left to right)
    const sorted = [...boxes].sort((a, b) => {
      const yDiff = (a.y || 0) - (b.y || 0);
      if (Math.abs(yDiff) < 5) return (a.x || 0) - (b.x || 0);
      return yDiff;
    });

    const lines = [];
    let current = null;

    for (const box of sorted) {
      if (!current) {
        current = { ...box };
        continue;
      }

      // Same line if Y positions are within 8px
      const yDist = Math.abs((box.y || 0) - (current.y || 0));
      const xGap = (box.x || 0) - ((current.x || 0) + (current.w || 0));

      if (yDist < 8 && xGap < 25 && xGap > -5) {
        // Same line — merge boxes
        const newRight = Math.max(
          (current.x || 0) + (current.w || 0),
          (box.x || 0) + (box.w || 0)
        );
        current.w = newRight - (current.x || 0);
        current.h = Math.max(current.h || 0, box.h || 0);
        current.y = Math.min(current.y || 0, box.y || 0);
        current.text = (current.text || "") + " " + (box.text || "");
      } else {
        // New line
        lines.push(current);
        current = { ...box };
      }
    }
    if (current) lines.push(current);

    return lines;
  }

  function assignLinesToBoxes(lines, boxes) {
    const sorted = [...boxes].sort((a, b) => (a.y || 0) - (b.y || 0));
    for (let i = 0; i < Math.min(lines.length, sorted.length); i++)
      sorted[i].text = lines[i];
    return sorted;
  }

  function isOK(r) { return r.status === "fulfilled" && r.value; }

  // ─── Render ───

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
          ctx.textBaseline = "middle";
          ctx.textAlign = "center";
          ctx.strokeStyle = "rgba(0,0,0,0.85)";
          ctx.lineWidth = Math.max(1.5, fs / 16);
          ctx.lineJoin = "round";

          const cy = (b.y || 0) + (b.h || 0) / 2;
          const cx = (b.x || 0) + (b.w || 0) / 2;
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
    const words = text.split(/\s+/), lines = [];
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
    await c.from("images").update({ status, updated_at: new Date().toISOString(), ...extra }).eq("id", id).eq("user_id", uid);
  }

  function report(fn, step, status, detail) { if (fn) fn(step, status, detail); }

  window.KagePipeline = { processImage, renderText };
})();
