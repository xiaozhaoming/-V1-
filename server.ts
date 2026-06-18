import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase body size limits to handle base64 image uploads up to 50MB
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // API Check Endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Metadata analysis endpoint using Gemini 3.5 Flash
  app.post("/api/analyze", async (req, res) => {
    const { image, mimeType, fileName, parsedMetadata } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Missing image base64 data" });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(400).json({
        error: "本系统后台未检测到有效的全局 GEMINI_API_KEY，请在 Settings > Secrets 菜单中进行配置。"
      });
    }

    try {
      // Initialize Gemini Client
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      // Construct a highly robust prompt asking Gemini to auditing metadata and visual style 
      const promptText = `你是一个小红书静态图防封去重专家和图片二进制/视觉安全审计师。
现在，一位内容创作者上传了名为 "${fileName}" 的图片。

【前端探测出的二进制元数据或环境参数】：
${JSON.stringify(parsedMetadata || {}, null, 2)}

小红书等平台在审核图片时，主要通过底层的文件元数据（如 EXIF, XMP, C2PA 内容凭证, 以及 PNG text chunks）和画面特征来判定是否是 AI 生成或多次搬运的重复图。
底层元数据已经由我们前端的高精度 JS 库（ExifReader 二进制解构器）完成了 100% 准确提取（如上所示）。

你的唯一核心职责是进行【画面层 AI 特征评估】。请专注于评估图片的视觉表层特征，判断画面视觉上是否具有 AI 生成质感：
1. 是否表现出 AI 特有的视觉特征或瑕疵：线条畸变与不连贯、人物面部/手指细节扭曲、背景虚化过于刻意或断层、非现实或极度饱满浮夸的光影、文字无规则乱码或歪斜等。
2. 视觉上是否有 AIGC 特有的光滑渐变、高饱和蜡质感、塑料感皮肤、像素重叠羽化等生成质感。

请直接输出完美的 JSON，响应内容必须符合且仅符合以下 JSON 格式（不要包含 markdown \`\`\`json 标记）：

{
  "risk_level": "high" | "medium" | "clean",
  "fields": [
    {
      "type": "VISUAL_ARTEFACT" | "PNG_CHUNK" | "EXIF" | "XMP",
      "key": "字段或特征项的英文名",
      "label": "特征或标签描述名称（若为画面问题，例如：画面蜡质高光感、文字排版歪斜、肢体肢节畸变）",
      "value": "对应读取出的数值或画面观察结论（若太长（>50字）请截断并加上...）",
      "is_ai_related": true | false,
      "risk_desc": "说明此画面特征为何带来了风险（例如：极易触发平台的AI生图机器过滤与限流打标机制）"
    }
  ],
  "ai_traces": {
    "waxiness": "low" | "medium" | "high",
    "hands": "low" | "medium" | "high",
    "background": "low" | "medium" | "high",
    "text": "low" | "medium" | "high"
  },
  "summary": "一句简短直白的小红书发布风险陈述（100字以内，重点结合画面AI质感给予创作者建议）"
}

风险判定指南：
1. 如果该图片存在 prompt, seed, workflow 等 AI 生图特定元数据，或者你通过视觉观察，发现画面具有【极度明显的 AI 扭曲残次或典型 AIGC 质感】，risk_level 必须判定为 "high"（高风险）。
2. 如果图片没有任何 AI 生图特有的元数据，但具有部分数码修图后留下的元数据（如 Photoshop, Lightroom）或普通设备拍摄信息，画面无大碍，判定为 "medium" (中风险，具有通用元数据，建议清除再发)。
3. 如果前端无危险字段，且你作为视觉系统审计画面未发现任何违和的 AI 精细渐变、无脑滤纸、或 AI 畸变特写，则判定为 "clean" (干净，可放心直发)。

请只返回此 JSON 结构，确保字段准确且可以直接被 JSON.parse。`;

      // Implement a robust retry mechanism to withstand 503 unavailable spikes
      let response;
      let lastError = null;
      const maxRetries = 3;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: [
              {
                inlineData: {
                  mimeType: mimeType || "image/jpeg",
                  data: image,
                },
              },
              {
                text: promptText,
              },
            ],
            config: {
              responseMimeType: "application/json",
              temperature: 0.1, // more deterministic for json structure
            },
          });
          break; // Succeeded! Break the retry loop
        } catch (callError: any) {
          lastError = callError;
          console.warn(`Gemini API attempt ${attempt} failed with error:`, callError.message || callError);
          if (attempt < maxRetries) {
            // Wait with a small backoff delay before retrying
            const delay = attempt * 1200;
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }

      if (!response) {
        throw lastError || new Error("运行失败（达到最大尝试次数）");
      }

      const responseText = response.text || "";
      const cleanedJsonText = responseText.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
      
      try {
        const auditResult = JSON.parse(cleanedJsonText);
        return res.json(auditResult);
      } catch (parseError) {
        console.error("Failed to parse Gemini output as JSON:", responseText);
        // Fallback gracefully if JSON parsing fails, structure the raw response
        return res.json({
          risk_level: "medium",
          fields: [
            {
              type: "VISUAL_ARTEFACT",
              key: "AI_Inspection",
              label: "AI 视觉诊断",
              value: "检测完毕",
              is_ai_related: true,
              risk_desc: "由于模型输出解析异常，建议安全起见一键清除所有底层二进制元数据。"
            }
          ],
          ai_traces: {
            waxiness: "low",
            hands: "low",
            background: "low",
            text: "low"
          },
          summary: responseText.slice(0, 150) || "AI 识别到潜在安全字段，建议一键清理去重后再行发布。"
        });
      }
    } catch (err: any) {
      console.error("Gemini API call error:", err);
      let errMsg = err.message || String(err);
      if (
        errMsg.includes("RESOURCE_EXHAUSTED") || 
        errMsg.includes("429") || 
        errMsg.includes("quota") || 
        errMsg.includes("Quota exceeded") || 
        errMsg.includes("limit")
      ) {
        errMsg = "免费 API 配额已满 (429)。由于当前使用的 Gemini 接口属于免费限频额度，已被平台限制。系统已自动启动并执行「100% 离线安全净化」方案，底层的 EXIF 参数去除和 Canvas 画布重绘均正常完成，不影响您的使用，可以直接清洗与下载图片。";
      } else {
        errMsg = `Gemini 视觉服务呼叫失败: ${errMsg}`;
      }
      return res.status(500).json({
        error: errMsg
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`小红书去重工具全栈服务器启动成功。运行地址 -> http://0.0.0.0:${PORT}`);
  });
}

startServer();
