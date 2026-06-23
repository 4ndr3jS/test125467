/**
 * Kage OCR API — Vercel Serverless Function
 * OCR.space (text + boxes) + manga-ocr HF Space (text only, Japanese)
 */

const OCR_SPACE_KEY = process.env.OCR_SPACE_KEY || "helloworld";

const LANG_MAP = {
 ja: "jpn", ko: "kor", zh: "chs", "zh-TW": "cht",
 en: "eng", fr: "fre", de: "ger", es: "spa", pt: "por", ru: "rus", ar: "ara", it: "ita",
};

const CJK_LANGS = new Set(["jpn", "kor", "chs", "cht"]);

function getEngine(lang) { return CJK_LANGS.has(lang) ? "1" : "2"; }
function normalizeLang(input = "ja") { return LANG_MAP[input] || "jpn"; }

async function fetchWithTimeout(url, options = {}, timeout = 25000) {
 const controller = new AbortController();
 const t = setTimeout(() => controller.abort(), timeout);
 try {
   const res = await fetch(url, { ...options, signal: controller.signal });
   return res;
 } catch (_) { return null; }
 finally { clearTimeout(t); }
}

async function ocrSpaceRequest(payload) {
 const res = await fetchWithTimeout("https://api.ocr.space/parse/image", {
   method: "POST",
   headers: { "Content-Type": "application/x-www-form-urlencoded" },
   body: new URLSearchParams(payload).toString(),
 });
 if (!res || !res.ok) return null;
 return res.json();
}

function parseOCR(data) {
 if (!data || data.IsErroredOnProcessing || !data.ParsedResults?.length) return null;

 let text = "";
 const boxes = [];

 for (const r of data.ParsedResults) {
   if (r.ParsedText) text += r.ParsedText.trim() + "\n";

   const lines = r.TextOverlay?.Lines || [];
   for (const line of lines) {
     if (line.Words?.length) {
       for (const w of line.Words) {
         if (!w.WordText) continue;
         boxes.push({
           x: w.Left || 0,
           y: w.Top || 0,
           w: w.Width || 50,
           h: w.Height || 20,
           text: w.WordText.trim(),
         });
       }
     } else if (line.LineText) {
       boxes.push({
         x: line.MinLeft || 0,
         y: line.MinTop || 0,
         w: (line.MaxRight || 0) - (line.MinLeft || 0) || 100,
         h: (line.MaxBottom || 0) - (line.MinTop || 0) || 30,
         text: line.LineText.trim(),
       });
     }
   }
 }

 return { text: text.trim(), boxes, engine: "ocrspace", orientation: data.ParsedResults?.[0]?.TextOrientation || "0" };
}

async function tryOCRSpace(imageUrl, sourceLang) {
 const lang = normalizeLang(sourceLang);

 const urlPayload = {
   apikey: OCR_SPACE_KEY, url: imageUrl, language: lang,
   isOverlayRequired: "true", OCREngine: getEngine(lang), scale: "true",
 };

 // Try URL method first
 let data = await ocrSpaceRequest(urlPayload);

 // Fall back to base64 if URL method failed or returned errored
 if (!data || data.IsErroredOnProcessing) {
   const img = await fetchWithTimeout(imageUrl, {}, 15000);
   if (!img) return parseOCR(data); // return what we have (null or errored)

   const buf = Buffer.from(await img.arrayBuffer());
   const base64 = buf.toString("base64");
   const type = img.headers.get("content-type") || "image/png";

   const basePayload = {
     apikey: OCR_SPACE_KEY, language: lang,
     base64Image: `data:${type};base64,${base64}`,
     isOverlayRequired: "true", OCREngine: getEngine(lang), scale: "true",
   };

   data = await ocrSpaceRequest(basePayload);
 }

 return parseOCR(data);
}

const MANGA_OCR_SPACES = [
 "https://gryan-galario-manga-ocr-demo.hf.space/api/predict",
 "https://detomo-japanese-ocr.hf.space/api/predict",
];

async function tryMangaOCR(imageUrl) {
 const img = await fetchWithTimeout(imageUrl, {}, 15000);
 if (!img) return null;

 const buf = Buffer.from(await img.arrayBuffer());
 const base64 = buf.toString("base64");

 for (const url of MANGA_OCR_SPACES) {
   const res = await fetchWithTimeout(url, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ data: [`data:image/png;base64,${base64}`] }),
   }, 30000);
   if (!res) continue;

   try {
     const json = await res.json();
     const text = (json.data?.[0] || "").trim();
     if (!text) continue;
     return { text, lines: text.split("\n").filter(Boolean), engine: "manga-ocr" };
   } catch (_) {}
 }
 return null;
}

export default async function handler(req, res) {
 res.setHeader("Access-Control-Allow-Origin", "*");
 res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
 res.setHeader("Access-Control-Allow-Headers", "Content-Type");
 if (req.method === "OPTIONS") return res.status(200).end();
 if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

 try {
   const { imageUrl, sourceLang = "ja", mode = "full" } = req.body;
   if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });

   if (mode === "text_only") {
     const m = await tryMangaOCR(imageUrl);
     if (m) return res.json({ text: m.text, lines: m.lines, boxes: [], engine: m.engine });
   }

   const full = await tryOCRSpace(imageUrl, sourceLang);
   if (full) return res.json(full);

   return res.status(503).json({ error: "OCR unavailable", retryAfter: 5 });
 } catch (e) {
   return res.status(500).json({ error: e.message });
 }
}
