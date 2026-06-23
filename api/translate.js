/**
 * Kage Translate API — Vercel Serverless Function
 * Primary: LibreTranslate (better European language quality)
 * Fallback: MyMemory (better Japanese/Korean/CJK)
 */

// LibreTranslate public instances (free, no key required)
const LT_INSTANCES = [
  "https://translate.argosopentech.com",
  "https://libretranslate.de",
  "https://lt.vern.cc",
];

async function tryLibreTranslate(text, sourceLang, targetLang) {
  for (const baseUrl of LT_INSTANCES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(`${baseUrl}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: text,
          source: sourceLang,
          target: targetLang,
          format: "text",
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) continue;

      const data = await res.json();
      if (data.translatedText) {
        return { translatedText: data.translatedText, engine: "libretranslate" };
      }
    } catch (_) {
      continue; // Try next instance
    }
  }
  return null;
}

async function tryMyMemory(text, sourceLang, targetLang) {
  const langPair = `${sourceLang}|${targetLang}`;
  const params = new URLSearchParams({ q: text, langpair: langPair });

  if (process.env.MYMEMORY_EMAIL) {
    params.set("de", process.env.MYMEMORY_EMAIL);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?${params.toString()}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();

    if (data.responseStatus !== 200 && data.responseStatus !== 403) {
      return null;
    }

    return {
      translatedText: data.responseData.translatedText,
      engine: "mymemory",
      match: data.responseData.match || 0,
    };
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { text, sourceLang = "ja", targetLang = "en" } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    // Strategy: LibreTranslate first for European languages, MyMemory first for CJK
    const cjkLangs = ["ja", "ko", "zh", "zh-TW"];
    const isCJK = cjkLangs.includes(sourceLang) || cjkLangs.includes(targetLang);

    let result;

    if (isCJK) {
      // MyMemory is better for Japanese/Korean/Chinese
      result = await tryMyMemory(text, sourceLang, targetLang);
      if (!result) {
        result = await tryLibreTranslate(text, sourceLang, targetLang);
      }
    } else {
      // LibreTranslate is better for European languages
      result = await tryLibreTranslate(text, sourceLang, targetLang);
      if (!result) {
        result = await tryMyMemory(text, sourceLang, targetLang);
      }
    }

    if (!result) {
      return res.status(500).json({ error: "All translation engines failed. Please retry." });
    }

    return res.status(200).json({
      translatedText: result.translatedText,
      engine: result.engine,
      sourceLang,
      targetLang,
    });
  } catch (err) {
    console.error("Translation error:", err);
    return res.status(500).json({ error: `Translation failed: ${err.message}` });
  }
}
