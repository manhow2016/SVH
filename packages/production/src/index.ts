/**
 * @svh/production —— AI 短剧生产领域包（文档 §6）。
 *
 * 职责边界：
 * - 只包含生产领域数据、领域规则与对象关系（Project / Script / Character /
 *   Scene / Storyboard / Shot / Asset）
 * - 禁止：AI API 调用、HTTP 请求、React UI、数据库 SQL（SQL 由 server 层
 *   Adapter 实现，本包仅声明仓储 Port）
 */
export * from "./errors";
export * from "./repository";
export * from "./service";
export * from "./project/project-types";
export * from "./project/project";
export * from "./script/script-types";
export * from "./script/script";
export * from "./character/character-types";
export * from "./character/character";
export * from "./scene/scene-types";
export * from "./scene/scene";
export * from "./storyboard/storyboard-types";
export * from "./storyboard/storyboard";
export * from "./shot/shot-types";
export * from "./shot/shot";
export * from "./asset/asset-types";
export * from "./asset/asset";
