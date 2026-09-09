import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index";

export type SVHDatabase = BetterSQLite3Database<typeof schema> & { $client: InstanceType<typeof Database> };

/**
 * 初始化建表 SQL（与 drizzle schema 保持一致）。
 *
 * 会员系统新增表（文档 §5）：
 * users / membership_tiers / membership_features / tier_features /
 * subscription_plans / user_subscriptions / promotions / promotion_plans。
 *
 * 新增列：workspaces.user_id（§20 用户隔离）、settings.user_id（§37 设置隔离）。
 *
 * 种子数据（§35/§36）采用「仅空表时播种」：首次建库插入默认数据；
 * 之后即使管理员删除了种子行（如删除模型 m_dash_qwen_max），重启也不会复活
 * （INSERT OR IGNORE 只能保证不覆盖 UPDATE，无法防止 DELETE 后复活）。
 */
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES production_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新会话',
  status TEXT NOT NULL DEFAULT 'idle',
  model_provider_id TEXT NOT NULL DEFAULT 'openai-compatible',
  model_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_call_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT NOT NULL,
  user_id TEXT,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key, user_id)
);

CREATE TABLE IF NOT EXISTS membership_tiers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS membership_features (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tier_features (
  id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL REFERENCES membership_tiers(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL REFERENCES membership_features(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  tier_id TEXT NOT NULL REFERENCES membership_tiers(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_days INTEGER NOT NULL,
  original_price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  tier_id TEXT NOT NULL REFERENCES membership_tiers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  original_price INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL,
  discount_value INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promotion_plans (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'balanced',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider_id, model_name)
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tier_features_tier ON tier_features(tier_id);
CREATE INDEX IF NOT EXISTS idx_tier_features_feature ON tier_features(feature_id);
CREATE INDEX IF NOT EXISTS idx_plans_tier ON subscription_plans(tier_id);
CREATE INDEX IF NOT EXISTS idx_user_subs_user ON user_subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_promotion_plans_plan ON promotion_plans(plan_id, promotion_id);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);

-- ============ 生产领域表（V0.2 文档 §17：项目/剧本/角色/场景/分镜/镜头/资产；V0.3 多集：集） ============

CREATE TABLE IF NOT EXISTS production_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  settings TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 短剧多集（V0.3）：Project → Episode(1..n)；剧本/场景/时间轴挂集（角色/资产跨集共享）。
CREATE TABLE IF NOT EXISTS production_episodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_production_episodes_project ON production_episodes(project_id);

CREATE TABLE IF NOT EXISTS production_scripts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES production_episodes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_characters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  appearance TEXT NOT NULL,
  personality TEXT,
  reference_asset_id TEXT,
  visual_profile TEXT,
  voice TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES production_episodes(id) ON DELETE SET NULL,
  script_id TEXT,
  sort_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  time TEXT,
  characters TEXT NOT NULL,
  visual_style TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_storyboards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES production_scenes(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  duration INTEGER NOT NULL,
  shot_type TEXT NOT NULL,
  camera_movement TEXT,
  image_prompt TEXT,
  video_prompt TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_shots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  storyboard_id TEXT NOT NULL REFERENCES production_storyboards(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  framing TEXT,
  camera_movement TEXT,
  action TEXT,
  dialogue TEXT,
  image_asset_id TEXT,
  video_asset_id TEXT,
  audio_asset_id TEXT,
  status TEXT NOT NULL,
  visual_style TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  workspace_path TEXT,
  mime_type TEXT,
  metadata TEXT,
  generation TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_production_projects_workspace ON production_projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_production_projects_user ON production_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_production_scripts_project ON production_scripts(project_id);
CREATE INDEX IF NOT EXISTS idx_production_characters_project ON production_characters(project_id);
CREATE INDEX IF NOT EXISTS idx_production_scenes_project ON production_scenes(project_id);
CREATE INDEX IF NOT EXISTS idx_production_scenes_script ON production_scenes(script_id);
CREATE INDEX IF NOT EXISTS idx_production_storyboards_project ON production_storyboards(project_id);
CREATE INDEX IF NOT EXISTS idx_production_storyboards_scene ON production_storyboards(scene_id);
CREATE INDEX IF NOT EXISTS idx_production_shots_project ON production_shots(project_id);
CREATE INDEX IF NOT EXISTS idx_production_shots_storyboard ON production_shots(storyboard_id);
CREATE INDEX IF NOT EXISTS idx_production_assets_project ON production_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_production_assets_workspace ON production_assets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_production_assets_user ON production_assets(user_id);

-- 资产库引用（我的资产 → 制作中心项目）：删除「我的资产」文件夹前的引用检查数据源
CREATE TABLE IF NOT EXISTS production_asset_library_refs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES production_assets(id) ON DELETE CASCADE,
  lib_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_production_asset_library_refs_path ON production_asset_library_refs(lib_path);
CREATE INDEX IF NOT EXISTS idx_production_asset_library_refs_asset ON production_asset_library_refs(asset_id);

-- V0.3 Phase 5：生成记录（一次生成 = 一行，含提示词/参考/任务/产出/审核/版本）
CREATE TABLE IF NOT EXISTS generation_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  shot_id TEXT,
  storyboard_id TEXT,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  provider_id TEXT,
  model_id TEXT,
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  prompt_metadata TEXT,
  input_ref TEXT,
  task_id TEXT,
  output_asset_id TEXT,
  status TEXT NOT NULL,
  review_status TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_records_project ON generation_records(project_id);
CREATE INDEX IF NOT EXISTS idx_generation_records_shot ON generation_records(shot_id);
CREATE INDEX IF NOT EXISTS idx_generation_records_task ON generation_records(task_id);

-- ============ 工作流表（V0.2 文档 §11/§15：workflows / workflow_nodes / production_tasks） ============

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL,
  input TEXT,
  output TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  node_id TEXT,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provider_id TEXT,
  provider_task_id TEXT,
  status TEXT NOT NULL,
  progress INTEGER,
  output_url TEXT,
  error TEXT,
  payload TEXT,
  claimed_by TEXT,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_id);
CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow ON workflow_nodes(workflow_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON production_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON production_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON production_tasks(status, created_at);

-- ============ 成片时间轴（V0.3 Phase 2：Project → Timeline → Track → Clip） ============
-- 删除策略：Timeline 随 Project 级联，Track 随 Timeline 级联，Clip 随 Track 级联；
-- Clip 关联的 Asset / Shot 删除时 SET NULL（解除绑定，保留时间轴布局）。

CREATE TABLE IF NOT EXISTS production_timelines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES production_projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES production_episodes(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  duration REAL NOT NULL DEFAULT 0,
  fps REAL NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_timeline_tracks (
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL REFERENCES production_timelines(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS production_timeline_clips (
  id TEXT PRIMARY KEY,
  timeline_id TEXT NOT NULL REFERENCES production_timelines(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES production_timeline_tracks(id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES production_assets(id) ON DELETE SET NULL,
  shot_id TEXT REFERENCES production_shots(id) ON DELETE SET NULL,
  start_time REAL NOT NULL,
  duration REAL NOT NULL,
  source_start_time REAL,
  source_duration REAL,
  sort_order INTEGER NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_production_timelines_project ON production_timelines(project_id);
CREATE INDEX IF NOT EXISTS idx_production_timeline_tracks_timeline ON production_timeline_tracks(timeline_id);
CREATE INDEX IF NOT EXISTS idx_production_timeline_clips_timeline ON production_timeline_clips(timeline_id);
CREATE INDEX IF NOT EXISTS idx_production_timeline_clips_track ON production_timeline_clips(track_id);

`;

// ============ 种子数据（仅空表时播种；§35/§36 默认初始化） ============
// 说明：INSERT OR IGNORE 只能保证「不覆盖更新」，无法防止管理员删除后重启复活；
// 因此改为运行时先检查表是否为空：空表才播种（首次建库），非空表（含被删除过）跳过。

const SEED_MEMBERSHIP_TIERS_SQL = `INSERT OR IGNORE INTO membership_tiers (id, code, name, description, sort_order, enabled, created_at, updated_at) VALUES
  ('tier_free',       'free',       '免费版', '基础功能，可体验 SVH 核心能力', 0, 1, 0, 0),
  ('tier_pro',        'pro',        '专业版', '完整 Agent / Workspace / 资产 / 工作流能力', 1, 1, 0, 0),
  ('tier_enterprise', 'enterprise', '企业版', '专业版全部能力 + 团队 / API / 企业特性', 2, 1, 0, 0);

-- 功能项（§8.1）`;

const SEED_MEMBERSHIP_FEATURES_SQL = `INSERT OR IGNORE INTO membership_features (id, code, name, description, created_at, updated_at) VALUES
  ('feat_agent_basic',          'agent.basic',          '基础智能体',   '使用基础 Agent 能力', 0, 0),
  ('feat_agent_advanced',       'agent.advanced',       '高级智能体',   '使用高级 Agent 能力', 0, 0),
  ('feat_workspace_basic',      'workspace.basic',      '基础工作区',   '使用工作区', 0, 0),
  ('feat_workspace_multi',      'workspace.multi',      '多工作区',     '创建多个工作区', 0, 0),
  ('feat_assets_library',       'assets.library',       '资产库',       '全局资产库（角色/场景/道具/音色）', 0, 0),
  ('feat_workflow_automation',  'workflow.automation',  '工作流自动化', '自动化工作流', 0, 0),
  ('feat_team_workspace',       'team.workspace',       '团队工作区',   '团队共享工作区', 0, 0),
  ('feat_team_member',          'team.member',          '团队成员',     '邀请团队成员', 0, 0),
  ('feat_api_access',           'api.access',           'API 访问',     '开放 API 访问', 0, 0),
  ('feat_enterprise_feature',   'enterprise.feature',   '企业特性',     '企业级专属特性', 0, 0);

-- 等级功能关联（§9 默认配置：免费版 2 项 / 专业版 6 项 / 企业版 10 项）`;

const SEED_TIER_FEATURES_SQL = `INSERT OR IGNORE INTO tier_features (id, tier_id, feature_id, enabled, config, created_at, updated_at) VALUES
  -- 免费版
  ('tf_free_agent_basic',     'tier_free',       'feat_agent_basic',         1, '{}', 0, 0),
  ('tf_free_workspace_basic', 'tier_free',       'feat_workspace_basic',     1, '{"maxWorkspaces":3}', 0, 0),
  -- 专业版
  ('tf_pro_agent_basic',      'tier_pro',        'feat_agent_basic',         1, '{}', 0, 0),
  ('tf_pro_agent_advanced',   'tier_pro',        'feat_agent_advanced',      1, '{}', 0, 0),
  ('tf_pro_workspace_basic',  'tier_pro',        'feat_workspace_basic',     1, '{}', 0, 0),
  ('tf_pro_workspace_multi',  'tier_pro',        'feat_workspace_multi',     1, '{"maxWorkspaces":50}', 0, 0),
  ('tf_pro_assets_library',   'tier_pro',        'feat_assets_library',      1, '{}', 0, 0),
  ('tf_pro_workflow_automation', 'tier_pro',     'feat_workflow_automation', 1, '{}', 0, 0),
  -- 企业版
  ('tf_ent_agent_basic',          'tier_enterprise', 'feat_agent_basic',         1, '{}', 0, 0),
  ('tf_ent_agent_advanced',       'tier_enterprise', 'feat_agent_advanced',      1, '{}', 0, 0),
  ('tf_ent_workspace_basic',      'tier_enterprise', 'feat_workspace_basic',     1, '{}', 0, 0),
  ('tf_ent_workspace_multi',      'tier_enterprise', 'feat_workspace_multi',     1, '{"maxWorkspaces":-1}', 0, 0),
  ('tf_ent_assets_library',       'tier_enterprise', 'feat_assets_library',      1, '{}', 0, 0),
  ('tf_ent_workflow_automation',  'tier_enterprise', 'feat_workflow_automation', 1, '{}', 0, 0),
  ('tf_ent_team_workspace',       'tier_enterprise', 'feat_team_workspace',      1, '{}', 0, 0),
  ('tf_ent_team_member',          'tier_enterprise', 'feat_team_member',         1, '{}', 0, 0),
  ('tf_ent_api_access',           'tier_enterprise', 'feat_api_access',          1, '{}', 0, 0),
  ('tf_ent_enterprise_feature',   'tier_enterprise', 'feat_enterprise_feature',  1, '{}', 0, 0);

-- 默认套餐（§10.2 示例；管理员可自由修改价格/天数/上下架，重启不会覆盖）`;

const SEED_SUBSCRIPTION_PLANS_SQL = `INSERT OR IGNORE INTO subscription_plans (id, tier_id, name, description, duration_days, original_price, currency, enabled, sort_order, created_at, updated_at) VALUES
  ('plan_pro_monthly',      'tier_pro',        '专业版月付', '专业版 30 天', 30,  3900,  'CNY', 1, 0, 0, 0),
  ('plan_pro_quarterly',    'tier_pro',        '专业版季付', '专业版 90 天', 90,  9900,  'CNY', 1, 1, 0, 0),
  ('plan_pro_yearly',       'tier_pro',        '专业版年付', '专业版 365 天', 365, 29900, 'CNY', 1, 2, 0, 0),
  ('plan_ent_monthly',      'tier_enterprise', '企业版月付', '企业版 30 天', 30,  9900,  'CNY', 1, 3, 0, 0),
  ('plan_ent_quarterly',    'tier_enterprise', '企业版季付', '企业版 90 天', 90,  26900, 'CNY', 1, 4, 0, 0),
  ('plan_ent_yearly',       'tier_enterprise', '企业版年付', '企业版 365 天', 365, 99900, 'CNY', 1, 5, 0, 0);

-- 可用模型目录（管理员后台可增删改；INSERT OR IGNORE 幂等，重启不覆盖管理员修改）`;

const SEED_MODELS_SQL = `INSERT OR IGNORE INTO models (id, provider_id, model_name, type, display_name, enabled, sort_order, created_at, updated_at) VALUES
  -- 火山引擎（方舟）
  ('m_volc_doubao_seed_16',       'volcengine', 'doubao-seed-1-6-250615',        'text',  '豆包 Seed 1.6',              1, 0, 0, 0),
  ('m_volc_doubao_15_pro',        'volcengine', 'doubao-1-5-pro-32k-250115',      'text',  '豆包 1.5 Pro 32K',           1, 1, 0, 0),
  ('m_volc_deepseek_v3',          'volcengine', 'deepseek-v3-250528',             'text',  'DeepSeek V3',                1, 2, 0, 0),
  ('m_volc_seedream_40',          'volcengine', 'doubao-seedream-4-0-250828',     'image', '豆包 Seedream 4.0',          1, 3, 0, 0),
  ('m_volc_seedream_30',          'volcengine', 'doubao-seedream-3-0-t2i-250415', 'image', '豆包 Seedream 3.0（文生图）', 1, 4, 0, 0),
  ('m_volc_seedance_pro',         'volcengine', 'doubao-seedance-1-0-pro-250528', 'video', '豆包 Seedance 1.0 Pro',      1, 5, 0, 0),
  ('m_volc_seedance_lite',        'volcengine', 'doubao-seedance-1-0-lite-250528','video', '豆包 Seedance 1.0 Lite',     1, 6, 0, 0),
  ('m_volc_tts',                  'volcengine', 'doubao-tts',                     'audio', '豆包语音合成（TTS）',       1, 7, 0, 0),
  ('m_volc_asr',                  'volcengine', 'doubao-asr',                     'audio', '豆包语音识别（ASR）',       1, 8, 0, 0),
  -- 阿里云百炼（DashScope）
  ('m_dash_qwen_max',             'dashscope',  'qwen-max',                       'text',  '通义千问 Max',               1, 0, 0, 0),
  ('m_dash_qwen_plus',            'dashscope',  'qwen-plus',                      'text',  '通义千问 Plus',              1, 1, 0, 0),
  ('m_dash_qwen_turbo',           'dashscope',  'qwen-turbo',                     'text',  '通义千问 Turbo',             1, 2, 0, 0),
  ('m_dash_qwen3_max',            'dashscope',  'qwen3-max',                      'text',  '通义千问 3 Max',             1, 3, 0, 0),
  ('m_dash_wanx_t2i',             'dashscope',  'wanx2.1-t2i-turbo',             'image', '通义万相 2.1（文生图）',     1, 4, 0, 0),
  ('m_dash_qwen_image',           'dashscope',  'qwen-image',                     'image', '通义千问 图像生成',          1, 5, 0, 0),
  ('m_dash_wanx_i2v',             'dashscope',  'wanx2.1-i2v-turbo',             'video', '通义万相 2.1（图生视频）',   1, 6, 0, 0),
  ('m_dash_wanx_t2v',             'dashscope',  'wanx2.1-t2v-turbo',             'video', '通义万相 2.1（文生视频）',   1, 7, 0, 0),
  ('m_dash_qwen_tts',             'dashscope',  'qwen-tts',                       'audio', '通义语音合成（TTS）',       1, 8, 0, 0),
  ('m_dash_cosyvoice',            'dashscope',  'cosyvoice-v2',                   'audio', 'CosyVoice V2',               1, 9, 0, 0);`;


/**
 * 运行种子：仅当表为空（无任何行）时插入默认数据（首次建库生效）。
 * 管理员删除过种子行 / 修改过数据后，重启不再覆盖或复活。
 */
function runSeeds(sqlite: InstanceType<typeof Database>): void {
  const seed = (table: string, sql: string): void => {
    const existing = sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    if (existing === undefined) {
      sqlite.exec(sql);
    }
  };
  seed('membership_tiers', SEED_MEMBERSHIP_TIERS_SQL);
  seed('membership_features', SEED_MEMBERSHIP_FEATURES_SQL);
  seed('tier_features', SEED_TIER_FEATURES_SQL);
  seed('subscription_plans', SEED_SUBSCRIPTION_PLANS_SQL);
  seed('models', SEED_MODELS_SQL);
}


/**
 * 设置 WAL，容忍冷启动双进程竞争：
 * SQLite 规定「切换 journal_mode」的锁不 invoke busy handler（busy_timeout 无效），
 * 对方进程恰在写事务时立即返回 SQLITE_BUSY——better-sqlite3 直接抛错。
 * 故自带同步重试（50ms × 100 次 ≈ 5s 预算，与 busy_timeout 对齐；毫秒级事务醒来即过）。
 */
function setWalWithRetry(sqlite: InstanceType<typeof Database>): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  for (let attempt = 0; ; attempt++) {
    try {
      sqlite.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      if (attempt >= 99 || !(err as Error).message.includes("locked")) throw err;
      Atomics.wait(view, 0, 0, 50); // 主线程同步睡 50ms（仅冷启动路径）
    }
  }
}

/**
 * 创建数据库客户端
 *
 * @param databaseUrl 形如 `file:./data/svh.db` 或普通文件路径
 * @returns drizzle 客户端（含 schema）
 */
export function createDatabase(databaseUrl: string): SVHDatabase {
  const filePath = resolveDatabasePath(databaseUrl);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(filePath);
  // 多进程（server + worker）共享单文件：写锁竞争时等待而非立即报错
  sqlite.pragma("busy_timeout = 5000");
  setWalWithRetry(sqlite);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(INIT_SQL);
  // 冷启动并发安全（worker 引入后 pnpm dev 双进程同库）：migrateSchema 是
  // 「PRAGMA 探测 → ALTER / DROP+RENAME」多步序列，runSeeds 是「查空 → 插入」，
  // 跨进程交错会 duplicate column 崩溃、最坏清空 settings；busy_timeout 救不了
  // 「已读到旧 schema」的窗口。包进 BEGIN IMMEDIATE 后第二进程在写锁上排队
  // （实测 better-sqlite3 尊重该 pragma 于 BEGIN），醒来在事务内重跑 PRAGMA
  // 探测即见新 schema，各步自然跳过（幂等）。DDL 为毫秒级，正常远小于 5s 等待；
  // 极端下撞 SQLITE_BUSY 超时报错可接受——冷启动显式失败优于半迁移状态。
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    migrateSchema(sqlite);
    backfillEpisodes(sqlite);
    backfillProjectSessions(sqlite);
    runSeeds(sqlite);
    sqlite.exec("COMMIT");
  } catch (err) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      /* 事务已被 SQLite 终止时忽略 */
    }
    throw err;
  }
  migrateLegacyTimestamps(sqlite);

  return drizzle(sqlite, { schema });
}

/**
 * 会员系统迁移（对已存在的旧库）：
 * - workspaces 增加 user_id 列（§20 用户隔离，历史数据归属在启动时分配给管理员）
 * - settings 重建为 (key, user_id) 复合主键（§37 设置按用户隔离）
 */
function migrateSchema(sqlite: InstanceType<typeof Database>): void {
  const columns = (table: string): string[] =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );

  if (!columns("workspaces").includes("user_id")) {
    sqlite.exec("ALTER TABLE workspaces ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;");
  }

  if (!columns("settings").includes("user_id")) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS settings_new (
        key TEXT NOT NULL,
        user_id TEXT,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, user_id)
      );
      INSERT OR IGNORE INTO settings_new (key, user_id, value, updated_at)
        SELECT key, NULL, value, updated_at FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
    `);
  }

  // V0.2：workflow_nodes 增加 sort_order（节点顺序稳定；新库由 INIT_SQL 直接建列）
  if (columns("workflow_nodes").includes("node_id") && !columns("workflow_nodes").includes("sort_order")) {
    sqlite.exec("ALTER TABLE workflow_nodes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;");
  }

  // V0.2 队列化：production_tasks 增加 payload / claimed_by / heartbeat_at
  const taskColumns = columns("production_tasks");
  if (taskColumns.includes("id") && !taskColumns.includes("payload")) {
    sqlite.exec("ALTER TABLE production_tasks ADD COLUMN payload TEXT;");
    sqlite.exec("ALTER TABLE production_tasks ADD COLUMN claimed_by TEXT;");
    sqlite.exec("ALTER TABLE production_tasks ADD COLUMN heartbeat_at INTEGER;");
  }

  // V0.3 Phase 3：production_characters 增加 visual_profile（角色视觉档案）
  if (columns("production_characters").includes("id") && !columns("production_characters").includes("visual_profile")) {
    sqlite.exec("ALTER TABLE production_characters ADD COLUMN visual_profile TEXT;");
  }

  // V0.3 Phase 4：production_scenes / production_shots 增加 visual_style（视觉风格覆盖）
  if (columns("production_scenes").includes("id") && !columns("production_scenes").includes("visual_style")) {
    sqlite.exec("ALTER TABLE production_scenes ADD COLUMN visual_style TEXT;");
  }
  if (columns("production_shots").includes("id") && !columns("production_shots").includes("visual_style")) {
    sqlite.exec("ALTER TABLE production_shots ADD COLUMN visual_style TEXT;");
  }

  // Phase C：角色配音音色 + 镜头配音资产
  if (columns("production_characters").includes("id") && !columns("production_characters").includes("voice")) {
    sqlite.exec("ALTER TABLE production_characters ADD COLUMN voice TEXT;");
  }
  if (columns("production_shots").includes("id") && !columns("production_shots").includes("audio_asset_id")) {
    sqlite.exec("ALTER TABLE production_shots ADD COLUMN audio_asset_id TEXT;");
  }

  // V0.3 多集：production_scripts / production_scenes / production_timelines 增加 episode_id（挂集）
  const addEpisodeColumn = (table: string): void => {
    if (columns(table).includes("id") && !columns(table).includes("episode_id")) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN episode_id TEXT REFERENCES production_episodes(id) ON DELETE SET NULL;`);
    }
  };
  addEpisodeColumn("production_scripts");
  addEpisodeColumn("production_scenes");
  addEpisodeColumn("production_timelines");
  // 集过滤索引（只能在列存在后创建：旧表加列在上一段完成）
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_production_timelines_episode ON production_timelines(episode_id);");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_production_scripts_episode ON production_scripts(episode_id);");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_production_scenes_episode ON production_scenes(episode_id);");

  // V0.3 会话绑定项目：sessions 增加 project_id（项目与会话一对一，用户不可新建会话）
  if (columns("sessions").includes("id") && !columns("sessions").includes("project_id")) {
    sqlite.exec(
      "ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES production_projects(id) ON DELETE CASCADE;",
    );
  }
  // 项目唯一会话索引（SQLite 允许多个 NULL，历史孤儿会话不受影响）
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_project_unique ON sessions(project_id);");

  // V0.3 系统选模型：models 增加 tier（生成方案档位 economy/balanced/quality）
  if (columns("models").includes("id") && !columns("models").includes("tier")) {
    sqlite.exec("ALTER TABLE models ADD COLUMN tier TEXT NOT NULL DEFAULT 'balanced';");
  }
}

/**
 * 多集回填（V0.3，幂等）：为「没有任何集」的项目（含改造前创建的存量项目）
 * 自动创建「第 1 集」并把既有剧本/场景/时间轴数据挂载上去——升级零丢失，
 * 并满足「项目必含第 1 集」的领域不变量（new 项目由 createProject 服务端自动建集）。
 * 仅在 BEGIN IMMEDIATE 事务内调用。
 */
function backfillEpisodes(sqlite: InstanceType<typeof Database>): void {
  const prefix = "epi_";
  const now = Date.now();
  const hex = (): string =>
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const rows = sqlite
    .prepare(
      `SELECT p.id AS project_id FROM production_projects p
        WHERE NOT EXISTS (SELECT 1 FROM production_episodes e WHERE e.project_id = p.id)`,
    )
    .all() as Array<{ project_id: string }>;
  const insEp = sqlite.prepare(
    "INSERT INTO production_episodes (id, project_id, sort_order, name, description, created_at, updated_at) VALUES (?, ?, 1, '第 1 集', NULL, ?, ?)",
  );
  const attach = (table: string, projectId: string, episodeId: string): void => {
    sqlite
      .prepare(`UPDATE ${table} SET episode_id = ? WHERE project_id = ? AND episode_id IS NULL`)
      .run(episodeId, projectId);
  };
  for (const row of rows) {
    const id = `${prefix}${hex()}`;
    insEp.run(id, row.project_id, now, now);
    attach("production_scripts", row.project_id, id);
    attach("production_scenes", row.project_id, id);
    attach("production_timelines", row.project_id, id);
  }
}

/**
 * 会话绑定项目回填（V0.3，幂等）：为「没有任何绑定会话」的项目自动创建
 * 绑定会话（标题=项目名），保证「每个项目恰有一个会话」的领域不变量
 * （新项目由服务端 createProject 自动建会话；此处覆盖升级前的存量项目）。
 * 仅在 BEGIN IMMEDIATE 事务内调用。
 */
function backfillProjectSessions(sqlite: InstanceType<typeof Database>): void {
  const prefix = "ses_";
  const now = Date.now();
  const hex = (): string =>
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const rows = sqlite
    .prepare(
      `SELECT p.id AS project_id, p.name AS project_name, p.workspace_id
        FROM production_projects p
        WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = p.id)`,
    )
    .all() as Array<{ project_id: string; project_name: string; workspace_id: string }>;
  const ins = sqlite.prepare(
    "INSERT INTO sessions (id, workspace_id, project_id, title, status, model_provider_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'idle', 'openai-compatible', '', ?, ?)",
  );
  for (const row of rows) {
    ins.run(`${prefix}${hex()}`, row.workspace_id, row.project_id, row.project_name || "新会话", now, now);
  }
}

/**
 * 旧库迁移：早期 created_at/updated_at 以「秒」存储（drizzle timestamp 模式），
 * 现改为毫秒精度（timestamp_ms），需将旧行 ×1000 对齐。
 */
function migrateLegacyTimestamps(sqlite: InstanceType<typeof Database>): void {
  const THRESHOLD = 100000000000; // 1e11：秒级值（~1.7e9）远小于此，毫秒级（~1.7e12）远大于此
  const tables: Array<[string, string[]]> = [
    ["workspaces", ["created_at", "updated_at"]],
    ["sessions", ["created_at", "updated_at"]],
    ["messages", ["created_at"]],
    ["settings", ["updated_at"]],
  ];
  for (const [table, columns] of tables) {
    for (const column of columns) {
      sqlite.exec(
        `UPDATE ${table} SET ${column} = ${column} * 1000 WHERE ${column} < ${THRESHOLD};`,
      );
    }
  }
}

/** 解析数据库 URL：剥离 file: 前缀 */
export function resolveDatabasePath(databaseUrl: string): string {
  let p = databaseUrl;
  if (p.startsWith("file:")) {
    p = p.slice("file:".length);
  }
  if (p === "") {
    throw new Error("Invalid database URL: empty path");
  }
  return path.resolve(p);
}
