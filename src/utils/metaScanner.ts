/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import ExifReader from "exifreader";

// Friendly mapping of standard tags to localized Chinese names
const EXIF_FRIENDLY_MAP: Record<string, string> = {
  // Equipment & Shooting
  "Make": "设备制造商 (Make)",
  "Model": "设备型号 (Model)",
  "Software": "处理软件/版权标识 (Software)",
  "DateTimeOriginal": "原始拍摄时间 (DateTimeOriginal)",
  "DateTime": "文件修改时间 (DateTime)",
  "ExposureTime": "曝光时间 (ExposureTime)",
  "FNumber": "光圈数值 (FNumber)",
  "ISOSpeedRatings": "ISO感光度 (ISO)",
  "LensModel": "镜头型号 (LensModel)",
  "LensMake": "镜头厂商 (LensMake)",
  "FocalLength": "拍摄焦距 (FocalLength)",
  
  // GPS & Location (Highly sensitive for duplicate/risk check)
  "GPSLatitude": "GPS纬度位置 (GPSLatitude)",
  "GPSLongitude": "GPS经度位置 (GPSLongitude)",
  "GPSAltitude": "GPS海拔高度 (GPSAltitude)",
  "GPSDateStamp": "GPS卫星定位日期 (GPSDateStamp)",
  
  // Custom or AI / Author identifiers
  "CreatorTool": "创作设计工具 (CreatorTool)",
  "Copyright": "版权标识记录 (Copyright)",
  "Artist": "着作权作者 (Artist)",
  "ImageDescription": "图像简述说明 (Description)",
  "UserComment": "用户底层注释 (UserComment)",
};

/**
 * Client-side binary scanning to detect EXIF/XMP rich information and AI parameters.
 * Uses exifreader for robust generic parsing and merges custom binary scanning for fallback safety.
 */
export async function scanImageMetadata(file: File): Promise<{
  metadata: Record<string, string>;
  hasAiIndicators: boolean;
  summary: string;
  hasExif: boolean;
  hasXmp: boolean;
  hasC2pa: boolean;
  hasPngText: boolean;
}> {
  const metadata: Record<string, string> = {};
  let hasAiIndicators = false;
  const aiDetails: string[] = [];
  const sensitiveExifDetails: string[] = [];
  let summary = "";

  let hasExif = false;
  let hasXmp = false;
  let hasC2pa = false;
  let hasPngText = false;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    
    // 1. Binary stream scanning for C2PA content credentials or JUMBF signatures
    const minLen = uint8.length;
    const headerSlice = uint8.slice(0, Math.min(minLen, 50000));
    const footerSlice = uint8.slice(Math.max(0, minLen - 50000));
    
    const binaryToString = (slice: Uint8Array) => {
      let str = "";
      for (let i = 0; i < slice.length; i += 5000) {
        str += String.fromCharCode(...slice.slice(i, i + 5000));
      }
      return str;
    };
    
    const headerStr = binaryToString(headerSlice);
    const footerStr = binaryToString(footerSlice);
    const fullSearchStr = (headerStr + " " + footerStr).toLowerCase();

    if (
      fullSearchStr.includes("c2pa") || 
      fullSearchStr.includes("jumbf") || 
      fullSearchStr.includes("content credentials") || 
      fullSearchStr.includes("prov:manifest")
    ) {
      hasC2pa = true;
      metadata["C2PA Content Credentials"] = "已发现安全追溯凭证 / 包含数字版权签署指纹";
    }

    if (fullSearchStr.includes("xmpmeta") || fullSearchStr.includes("adobe:ns:meta") || fullSearchStr.includes("x:xmptg")) {
      hasXmp = true;
    }

    // 2. Pass to ExifReader first
    let tags: any = {};
    try {
      tags = ExifReader.load(arrayBuffer);
    } catch (e) {
      console.warn("ExifReader load failed (continuing with custom manual parse):", e);
    }

    // 3. Process ExifReader tags
    const aiKeywords = [
      "stable diffusion", "stablediffusion", "midjourney", "comfyui", "novelai", "dall-e",
      "firefly", "generative", "ai generator", "stealth", "playground", "fooocus", "prompt", "workflow"
    ];

    const tagsKeys = Object.keys(tags);
    if (tagsKeys.length > 0) {
      const hasOnlyFileDetails = tagsKeys.every(k => k === "FileType" || k === "File Size" || k === "Image Height" || k === "Image Width");
      if (!hasOnlyFileDetails) {
        hasExif = true;
      }
    }

    for (const [tagName, tagData] of Object.entries(tags)) {
      if (!tagData) continue;
      
      // Get formatted value description
      let rawVal = "";
      if (typeof tagData === "object" && tagData !== null) {
        rawVal = String((tagData as any).description || (tagData as any).value || "").trim();
      } else {
        rawVal = String(tagData).trim();
      }

      if (!rawVal) continue;

      const lowerTag = tagName.toLowerCase();
      const lowerVal = rawVal.toLowerCase();

      if (lowerTag.includes("xmp")) {
        hasXmp = true;
      }

      // Check if tag is AI related
      const isAi = aiKeywords.some(kw => lowerVal.includes(kw) || lowerTag.includes(kw));
      if (isAi) {
        hasAiIndicators = true;
        
        let label = tagName;
        if (tagName === "parameters" && lowerVal.includes("steps:")) {
          aiDetails.push(`发现 SD/A1111 parameters 绘图提示词与生成参数`);
          label = "Stable Diffusion 提示词 (parameters)";
        } else if (lowerTag.includes("workflow") || lowerVal.includes("comfyui")) {
          aiDetails.push(`发现 ComfyUI 工作流元数据`);
          label = "ComfyUI 工作流 (workflow)";
        } else {
          aiDetails.push(`发现 AI 关联标记 [${tagName}]`);
        }
        
        // Truncate overly long parameter blocks to make rendering neat
        metadata[label] = rawVal.length > 500 ? rawVal.substring(0, 500) + "..." : rawVal;
      } else if (lowerTag.includes("gps")) {
        // Collect location sensitive tags
        sensitiveExifDetails.push("GPS精确地理定位");
        metadata[EXIF_FRIENDLY_MAP[tagName] || tagName] = rawVal;
      } else if (EXIF_FRIENDLY_MAP[tagName]) {
        // If in standard list of interesting tags, collect it with local friendly label
        metadata[EXIF_FRIENDLY_MAP[tagName]] = rawVal;
        if (tagName === "Software" || tagName === "CreatorTool") {
          sensitiveExifDetails.push("常用版修图软件签名");
        } else if (tagName === "Model" || tagName === "Make") {
          sensitiveExifDetails.push("相机拍摄器材型号");
        }
      } else if (tagName === "ICC Profile" || tagName === "Iptc" || tagName === "XMP") {
        // Broad categories
        metadata[tagName] = `[包含底层二进制配置段，大小: ${rawVal.length} 字节]`;
      }
    }

    // 4. Fallback/Double Check: Custom manual scan particularly for raw PNG text chunks
    // to capture key values that might not map under standard tag categories.
    if (file.type === "image/png" || file.name.endsWith(".png")) {
      let pos = 8;
      const len = uint8.length;
      while (pos + 8 < len) {
        const chunkLength = (uint8[pos] << 24) | (uint8[pos + 1] << 16) | (uint8[pos + 2] << 8) | uint8[pos + 3];
        const chunkType = String.fromCharCode(uint8[pos + 4], uint8[pos + 5], uint8[pos + 6], uint8[pos + 7]);
        pos += 8;
        if (pos + chunkLength > len) break;

        if (chunkType === "tEXt" || chunkType === "iTXt" || chunkType === "zTXt") {
          hasPngText = true;
          let key = "";
          let keyEnd = pos;
          for (let i = pos; i < pos + chunkLength; i++) {
            if (uint8[i] === 0) {
              keyEnd = i;
              break;
            }
          }
          key = String.fromCharCode(...uint8.slice(pos, keyEnd)).trim();
          let val = "";
          if (chunkType === "tEXt") {
            const valStart = keyEnd + 1;
            const valEnd = pos + chunkLength;
            if (valStart < valEnd) {
              val = String.fromCharCode(...uint8.slice(valStart, valEnd));
            }
          } else {
            val = `[压缩或UTF-8文本块 (大小: ${chunkLength} 字节)]`;
          }

          if (key && !metadata[key] && !metadata[EXIF_FRIENDLY_MAP[key]]) {
            const lowerKey = key.toLowerCase();
            const lowerVal = val.toLowerCase();
            const isAiVal = aiKeywords.some(kw => lowerVal.includes(kw) || lowerKey.includes(kw));
            
            if (isAiVal) {
              hasAiIndicators = true;
              aiDetails.push(`发现 PNG 底层敏感文本块 [${key}]`);
              metadata[`PNG ${key} 字段`] = val.length > 500 ? val.substring(0, 500) + "..." : val;
            } else {
              metadata[`PNG ${key} (未知文本)`] = val.length > 200 ? val.substring(0, 200) + "..." : val;
            }
          }
        } else if (chunkType === "IEND") {
          break;
        } else {
          pos += chunkLength;
        }
        pos += 4; // skip CRC
      }
    }
  } catch (error) {
    console.error("Client metadata reader error:", error);
  }

  // Generate extremely rich and localized intelligence summary
  const uniqueAiDetails = Array.from(new Set(aiDetails));
  const uniqueSensitiveExifs = Array.from(new Set(sensitiveExifDetails));

  if (hasAiIndicators) {
    summary = `🔍 极高判定风险！读取到生成式 AI 原生特有签名字段: ${uniqueAiDetails.join("、")}。此类元数据会百分之百被小红书和抖音等平台检测到，进而触发“AI生成标识”强制打标，或者判定为低质/非原创内容。建议立即执行物理脱敏重绘！`;
  } else if (uniqueSensitiveExifs.length > 0) {
    const keys = Object.keys(metadata);
    summary = `⚠️ 中等安全风险！未检测到 AIGC 原生特定参数，但包含 ${uniqueSensitiveExifs.join("及")} (已解析标签数量: ${keys.length} 项，含设备或软件标识)。平台算法极易据此交叉匹配，从而判定为设备搬运号或二创剪辑。必须进行首尾脱敏清除。`;
  } else {
    if (hasExif || hasXmp || hasC2pa || hasPngText) {
      summary = `⚠️ 低风险提示：检测到普通图片标头/空指纹记录。虽未包含 AI 特征，但保留的元数据信息可能暴露制作足迹，仍建议执行物理净化。`;
    } else {
      summary = `✨ 极度纯澈安全！此图片文件头已实现物理净化无垢，未在底层检测到任何 EXIF 标头、XMP 容器、软件渲染记录或 GPS 空间戳，可放心发布。`;
    }
  }

  return {
    metadata,
    hasAiIndicators,
    summary,
    hasExif,
    hasXmp,
    hasC2pa,
    hasPngText,
  };
}
