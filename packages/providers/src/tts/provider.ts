/**
 * TTS（语音合成）Provider 接口（Phase C：成片链路配音）。
 *
 * 第一版支持 OpenAI Compatible `/v1/audio/speech`（多数 TTS 网关兼容）；
 * 输出统一为 url（远程地址）或 b64Json（字节落库 metadata，供本地转存/预览）。
 */
export interface TTSSynthesisInput {
  model: string;
  /** 待合成文本（对白/旁白） */
  input: string;
  /** 音色名（模型支持的 voice；缺省供应商默认） */
  voice?: string;
  /** 输出格式：mp3 | opus | aac | flac（openai-compatible 语义） */
  responseFormat?: "mp3" | "opus" | "aac" | "flac";
}

export interface TTSSynthesisResult {
  /** 远程 URL（网关返回 JSON 形态时）；b64 形态两者互斥 */
  url?: string;
  /** base64 音频字节（响应为二进制时转存；与 url 二选一） */
  b64Json?: string;
  /** 音频 MIME（如 audio/mpeg；b64 形态的媒体类型） */
  contentType?: string;
}

export interface TTSService {
  /** 统一注册 id（如 "openai-compatible-tts"） */
  id: string;
  synthesize(input: TTSSynthesisInput, signal?: AbortSignal): Promise<TTSSynthesisResult>;
}
