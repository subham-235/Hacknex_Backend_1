
const { GoogleGenAI } = require("@google/genai");
const path = require("path");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});


const analyzeAudioDirectly = async (audioPath, location) => {
  try {
    if (!audioPath) {
      throw new Error("Audio path is required");
    }

   
    const extension = path
      .extname(audioPath)
      .toLowerCase();


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

    const mimeType =
      mimeTypes[extension];

    if (!mimeType) {
      throw new Error(
        `Unsupported audio format: ${extension}`
      );
    }

    console.log("Uploading file to Gemini...");
    console.log("Audio:", audioPath);
    console.log("MIME:", mimeType);

    const uploadedFile = await ai.files.upload({
      file: audioPath,

      config: {
        mimeType,
      },
    });

    console.log(
      "Gemini file uploaded:",
      uploadedFile.uri
    );

  

    const prompt = `
You are an emergency distress detection AI.

Analyze the provided audio carefully.

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
      await ai.models.generateContent({
        model: "gemini-3.6-flash",

        contents: [
          {
            text: prompt,
          },

          {
            fileData: {
              fileUri: uploadedFile.uri,
              mimeType: uploadedFile.mimeType,
            },
          },
        ],
      });



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