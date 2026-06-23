/**
 * Kage OCR API — Vercel Serverless Function
 * Primary: OCR.space (free, returns text + word-level bounding boxes)
 * The old Hugging Face inference API is dead.
 */

// OCR.space free API key for testing (500 req/day).
// Replace with a registered key from https://ocr.space/OCRAPI for higher limits.
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

async function tryOCRSpace(imageUrl, sourceLang) {
  const lang = LANG_MAP[sourceLang] || "jpn";

  // First try: pass URL directly (faster, less bandwidth)
  let result = await ocrSpaceURL(imageUrl, lang);

  // If URL method fails, download image and send as base64
  if (!result) {
    result = await ocrSpaceBase64(imageUrl, lang);
  }

  return result;
}

async function ocrSpaceURL(imageUrl, lang) {
  const formData = new URLSearchParams();
  formData.append("apikey", OCR_SPACE_KEY);
  formData.append("url", imageUrl);
  formData.append("language", lang);
  formData.append("isOverlayRequired", "true");
  formData.append("OCREngine", "2");
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const imgRes = await fetch(imageUrl, {
      headers: { "User-Agent": "Kage/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!imgRes.ok) return null;
    const contentType = imgRes.headers.get("content-type") || "image/png";
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
    const base64 = imgBuffer.toString("base64");

    const formData = new URLSearchParams();
    formData.append("apikey", OCR_SPACE_KEY);
    formData.append("base64Image", `data:${contentType};base64,${base64}`);
    formData.append("language", lang);
    formData.append("isOverlayRequired", "true");
    formData.append("OCREngine", "2");
    formData.append("scale", "true");

    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), 30000);

    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
      signal: c2.signal,
    });

    clearTimeout(t2);
    if (!res.ok) return null;
    return parseOCRSpaceResponse(await res.json());
  } catch (_) {
    return null;
  }
}

function parseOCRSpaceResponse(data) {
  if (data.IsErroredOnProcessing || !data.ParsedResults?.length) return null;

    // Extract text and bounding boxes from OCR.space response
    let fullText = "";
    const boxes = [];

    for (const result of data.ParsedResults) {
      if (result.ParsedText) {
        fullText += result.ParsedText.trim() + "\n";
      }

      // OCR.space returns word-level bounding boxes in TextOverlay.Lines
      if (result.TextOverlay?.Lines) {
        for (const line of result.TextOverlay.Lines) {
          const lineText = line.LineText?.trim();
          if (!lineText) continue;

          // Each line has Words with bounding boxes
          if (line.Words?.length > 0) {
            for (const word of line.Words) {
              if (word.WordText?.trim()) {
                boxes.push({
                  x: word.Left || 0,
                  y: word.Top || 0,
                  w: word.Width || 50,
                  h: word.Height || 20,
                  text: word.WordText.trim(),
                });
              }
            }
          } else if (lineText) {
            // Line-level box (no word breakdown)
            // Estimate box from line text position
            boxes.push({
              x: line.MinLeft || 0,
              y: line.MinTop || 0,
              w: (line.MaxRight || 200) - (line.MinLeft || 0),
              h: (line.MaxBottom || 30) - (line.MinTop || 0),
              text: lineText,
            });
          }
        }
      }
    }

    fullText = fullText.trim();

    return {
      text: fullText,
      boxes,
      engine: "ocrspace",
      orientation: data.ParsedResults[0]?.TextOrientation || "0",
    };
}

// HF Space manga-ocr (free, excellent accuracy, but text-only — no bounding boxes)
// The frontend combines this text with Tesseract.js bounding boxes

const MANGA_OCR_SPACES = [
  "https://gryan-galario-manga-ocr-demo.hf.space/api/predict",
  "https://detomo-japanese-ocr.hf.space/api/predict",
];

async function tryMangaOCRSpace(imageUrl) {
  // Download image once for all spaces
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
        // Split by newlines for line-level matching with Tesseract boxes
        const lines = text.split("\n").filter(Boolean);
        return {
          text,
          lines,
          engine: "manga-ocr-space",
        };
      }
    } catch (_) {
      continue;
    }
  }

  return null;
}

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

    // For "text_only" mode: use manga-ocr HF Space (best accuracy, no bboxes)
    if (mode === "text_only") {
      const textResult = await tryMangaOCRSpace(imageUrl);
      if (textResult) {
        return res.status(200).json({ text: textResult.text, boxes: [], engine: textResult.engine });
      }
    }

    // Full mode: OCR.space (text + bounding boxes)
    const fullResult = await tryOCRSpace(imageUrl, sourceLang);
    if (fullResult) {
      return res.status(200).json(fullResult);
    }

    // If both fail, return error so client can fall back to Tesseract
    return res.status(503).json({
      error: "All OCR engines unavailable. Try again or use offline mode.",
      retryAfter: 5,
    });
  } catch (err) {
    console.error("OCR error:", err);
    return res.status(500).json({ error: `OCR failed: ${err.message}` });
  }
}
