export type RiskLevel = "high" | "medium" | "clean" | "analyzing" | "failed";

export interface MetadataField {
  type: "EXIF" | "XMP" | "C2PA" | "PNG_CHUNK" | "VISUAL_ARTEFACT";
  key: string;
  label: string;
  value: string;
  is_ai_related: boolean;
  risk_desc?: string;
}

export interface ImageFileState {
  id: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  previewUrl: string;
  
  // Client-side quick binary review
  clientParsedMetadata: Record<string, string>;
  hasClientDetectedAi: boolean;
  clientAiSummary: string;
  hasExif?: boolean;
  hasXmp?: boolean;
  hasC2pa?: boolean;
  hasPngText?: boolean;
  
  // Gemini Deep Audit
  riskLevel: RiskLevel;
  auditFields: MetadataField[];
  aiTraces?: {
    waxiness: "low" | "medium" | "high";
    hands: "low" | "medium" | "high";
    background: "low" | "medium" | "high";
    text: "low" | "medium" | "high";
  };
  summary: string;
  auditError?: string;
  
  // State variables for processing
  status: "idle" | "analyzing" | "completed" | "clearing" | "cleared" | "verifying" | "verified" | "failed";
  progress: number;
  
  // Scrubbed image data
  cleanedBlob?: Blob;
  cleanedUrl?: string;
  cleanedSize?: number;
}
