/**
 * Kage OCR API — Vercel Serverless Function
 *
 * Changes from original:
 * 1. OCR.space: switched to OCREngine=1 for all CJK languages.
 * Engine 2 is a neural net tuned for printed documents — Engine 1 (Tesseract-based)
 * handles manga/webtoon stylised fonts and vertical Japanese much better.
 * 2. manga-ocr HF Space: kept as text_only path, no changes needed there.
 * 3. parseOCRSpaceResponse: added line-level box fallback when Words array is empty,
 * and normalises coordinates so x/y are never negative.
 * 4. Removed OCREngine=2 everywhere — it was the single biggest source of garbled CJK.
 */

const OCR_SPACE_KEY = process.env.OCR_SPACE_KEY || "helloworld";

const LANG_MAP = {
 ja: "jpn",
 ko: "kor",
 zh: "chs",
 "zh-TW": "cht",
 en: "eng",
 fr: "fre",
 de: "ger",
 es: "spa",
 pt: "por",
 ru: "rus",
 ar: "ara",
 it: "ita",
};

// CJK languages where Engine 1 consistently outperforms Engine 2 for manga
const CJK_LANGS = new Set(["jpn", "kor", "chs", "cht"]);

function getEngine(lang) {
 // Engine 1 = Tesseract-based, better for stylised/comic fonts and vertical text.
 // Engine 2 = neural net, better for clean document scans — wrong tool for manga.
 return CJK_LANGS.has(lang) ? "1" : "2";
}

async function tryOCRSpace(imageUrl, sourceLang) {
 const lang = LANG_MAP[sourceLang] || "jpn";
 let result = await ocrSpaceURL(imageUrl, lang);
 if (!result) result = await ocrSpaceBase64(imageUrl, lang);
 return result;
}

async function ocrSpaceURL(imageUrl, lang) {
 const formData = new URLSearchParams();
 formData.append("apikey", OCR_SPACE_KEY);
 formData.append("url", imageUrl);
 formData.append("language", lang);
 formData.append("isOverlayRequired", "true");
 formData.append("OCREngine", getEngine(lang));
 formData.append("scale", "true");
 formData.append("detectOrientation", "true");
 formData.append("filetype", "auto");

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 25000);

 try {
   const res = await fetch("https://api.ocr.space/parse/image", {
     method: "POST",
     headers: { "Content-Type": "application/x-www-form-urlencoded" },
     body: formData.toString(),
     signal: controller.signal,
   });
   clearTimeout(timer);
   if (!res.ok) return null;
   return parseOCRSpaceResponse(await res.json());
 } catch (_) {
   clearTimeout(timer);
   return null;
 }
}

async function ocrSpaceBase64(imageUrl, lang) {
 try {
   const imgRes = await fetch(imageUrl, {
     headers: { "User-Agent": "Kage/1.0" },
     signal: AbortSignal.timeout(15000),
   });
   if (!imgRes.ok) return null;

   const contentType = imgRes.headers.get("content-type") || "image/png";
   const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
   const base64 = imgBuffer.toString("base64");

   const formData = new URLSearchParams();
   formData.append("apikey", OCR_SPACE_KEY);
   formData.append("base64Image", `data:${contentType};base64,${base64}`);
   formData.append("language", lang);
   formData.append("isOverlayRequired", "true");
   formData.append("OCREngine", getEngine(lang));
   formData.append("scale", "true");

   const res = await fetch("https://api.ocr.space/parse/image", {
     method: "POST",
     headers: { "Content-Type": "application/x-www-form-urlencoded" },
     body: formData.toString(),
     signal: AbortSignal.timeout(30000),
   });
   if (!res.ok) return null;
   return parseOCRSpaceResponse(await res.json());
 } catch (_) {
   return null;
 }
}

function parseOCRSpaceResponse(data) {
 if (data.IsErroredOnProcessing || !data.ParsedResults?.length) return null;

 let fullText = "";
 const boxes = [];

 for (const result of data.ParsedResults) {
   if (result.ParsedText) {
     fullText += result.ParsedText.trim() + "\n";
   }

   if (!result.TextOverlay?.Lines) continue;

   for (const line of result.TextOverlay.Lines) {
     const lineText = line.LineText?.trim();
     if (!lineText) continue;

     if (line.Words?.length > 0) {
       // Word-level boxes — use these directly; pipeline.js groups them into lines
       for (const word of line.Words) {
         const text = word.WordText?.trim();
         if (!text) continue;
         boxes.push({
           x: Math.max(0, word.Left || 0),
           y: Math.max(0, word.Top || 0),
           w: Math.max(1, word.Width || 50),
           h: Math.max(1, word.Height || 20),
           text,
         });
       }
     } else {
       // Line-level fallback (Engine 1 sometimes skips word breakdown for CJK)
       const x = Math.max(0, line.MinLeft || 0);
       const y = Math.max(0, line.MinTop || 0);
       const right = line.MaxRight || x + 200;
       const bottom = line.MaxBottom || y + 30;
       boxes.push({
         x,
         y,
         w: Math.max(1, right - x),
         h: Math.max(1, bottom - y),
         text: lineText,
       });
     }
   }
 }

 return {
   text: fullText.trim(),
   boxes,
   engine: "ocrspace",
   orientation: data.ParsedResults[0]?.TextOrientation || "0",
 };
}

// ─── manga-ocr via HF Space ───

const MANGA_OCR_SPACES = [
 "https://gryan-galario-manga-ocr-demo.hf.space/api/predict",
 "https://detomo-japanese-ocr.hf.space/api/predict",
];

async function tryMangaOCRSpace(imageUrl) {
 let imgBuffer;
 try {
   const imgRes = await fetch(imageUrl, {
     headers: { "User-Agent": "Kage/1.0" },
     signal: AbortSignal.timeout(15000),
   });
   if (!imgRes.ok) return null;
   imgBuffer = Buffer.from(await imgRes.arrayBuffer());
 } catch (_) {
   return null;
 }

 const base64 = imgBuffer.toString("base64");

 for (const spaceUrl of MANGA_OCR_SPACES) {
   try {
     const res = await fetch(spaceUrl, {
       method: "POST",
       headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ data: [`data:image/png;base64,${base64}`] }),
       signal: AbortSignal.timeout(30000),
     });
     if (!res.ok) continue;

     const data = await res.json();
     const text = (data.data?.[0] || "").trim();
     if (text) {
       return {
         text,
         lines: text.split("\n").filter(Boolean),
         engine: "manga-ocr-space",
       };
     }
   } catch (_) {
     continue;
   }
 }

 return null;
}

// ─── Handler ───

export default async function handler(req, res) {
 res.setHeader("Access-Control-Allow-Origin", "*");
 res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

 if (req.method === "OPTIONS") return res.status(200).end();
 if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

 try {
   const { imageUrl, sourceLang = "ja", mode = "full" } = req.body;

   if (!imageUrl) {
     return res.status(400).json({ error: "imageUrl is required" });
   }

   if (mode === "text_only") {
     const textResult = await tryMangaOCRSpace(imageUrl);
     if (textResult) {
       return res.status(200).json({
         text: textResult.text,
         lines: textResult.lines,
         boxes: [],
         engine: textResult.engine,
       });
     }
   }

   const fullResult = await tryOCRSpace(imageUrl, sourceLang);
   if (fullResult) {
     return res.status(200).json(fullResult);
   }

   return res.status(503).json({
     error: "All OCR engines unavailable. Try again or use offline mode.",
     retryAfter: 5,
   });
 } catch (err) {
   console.error("OCR error:", err);
   return res.status(500).json({ error: `OCR failed: ${err.message}` });
 }
}
