
const path = require("path");
const fs = require("node:fs/promises");
const { createGeminiFailover } = require("./geminiFailover");

const ai = createGeminiFailover();


const analyzeAudioDirectly = async (audioPath, location) => {
  try {
    if (!audioPath) {
      throw new Error("Audio path is required");
    }

   


    const mimeTypes = {
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".webm": "audio/webm",
      ".ogg": "audio/ogg",
      ".oga": "audio/ogg",
      ".aac": "audio/aac",
      ".flac": "audio/flac",
      ".aiff": "audio/aiff",
      ".m4a": "audio/mp4",
      ".mp4": "video/mp4",
    };

    const paths = Array.isArray(audioPath) ? audioPath : [audioPath];
    if (!paths.length || paths.length > 5) throw new Error("Expected one to five audio clips");
    const sizes = await Promise.all(paths.map(file => fs.stat(file)));
    // Base64 adds ~33%; leave ample room below the 20 MB request limit.
    if (sizes.reduce((sum, info) => sum + info.size, 0) > 12 * 1024 * 1024) {
      throw new Error("Audio batch exceeds inline request limit");
    }
    const audioParts = await Promise.all(paths.map(async file => {
      const mimeType = mimeTypes[path.extname(file).toLowerCase()];
      if (!mimeType) throw new Error("Unsupported audio format");
      return { inlineData: { mimeType, data: (await fs.readFile(file)).toString("base64") } };
    }));
    const analysisStartedAt = Date.now();
    const prompt = `
You are an emergency distress detection AI.

Analyze the provided audio clips in chronological order as one recording. Return one result for the whole batch. Keep the summary and reason to one short sentence each.

The user's approximate location is:

${location}

Your job is to:

1. Transcribe exactly what the person says.
2. Determine whether this is a genuine distress/emergency situation.
3. Determine the person's emotional state from the speech.
4. Determine the severity of the situation.
5. Give a confidence percentage from 0 to 100.
6. Generate a short emergency summary.
7. Explain why you classified it as distress or non-distress.

IMPORTANT:

- Do NOT assume every emotional or angry statement is an emergency.
- Look for actual indications of danger, threat, violence,
  kidnapping, assault, medical emergency, accident, begging
  for help, stalking, domestic violence, or similar situations.
- Consider the words AND tone of voice.
- If the person is simply talking normally, return isDistress=false.
- If the person clearly asks for help or appears to be in immediate
  danger, return isDistress=true.
- Do not invent information that is not present in the audio.
- Keep the summary short and useful for an emergency SMS.

Return ONLY valid JSON.

The JSON must have exactly this structure:

{
  "transcript": "string",
  "isDistress": true,
  "confidence": 0,
  "emotion": "string",
  "severity": "low | medium | high | critical",
  "summary": "string",
  "reason": "string"
}
`;

    const response =
      await ai.generateContent({
        model: "gemini-3.6-flash",

        contents: [
          {
            text: prompt,
          },

          ...audioParts,
        ],
      });



    console.log("SOS timing", { stage: "gemini_analysis", elapsedMs: Date.now() - analysisStartedAt, clips: paths.length });
    const rawText =
      response.text?.trim();

    console.log(
      "Gemini raw response:",
      rawText
    );

    if (!rawText) {
      throw new Error(
        "Gemini returned an empty response"
      );
    }

  

    const cleanedText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let result;

    try {
      result = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error(
        "Gemini JSON parsing failed:",
        cleanedText
      );

      throw new Error(
        "Gemini returned invalid JSON"
      );
    }

    // ─────────────────────────────────────────
    // Validate response
    // ─────────────────────────────────────────

    return {
      transcript:
        result.transcript || "",

      isDistress:
        Boolean(result.isDistress),

      confidence:
        Number(result.confidence) || 0,

      emotion:
        result.emotion || "unknown",

      severity:
        result.severity || "low",

      summary:
        result.summary || "",

      reason:
        result.reason || "",
    };

  } catch (error) {
    console.error(
      "analyzeAudioDirectly Error:",
      error
    );

    throw error;
  }
};


module.exports = {
  analyzeAudioDirectly,
};
