-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('short_video', 'advertisement', 'short_drama', 'digital_human', 'promo', 'visual_content');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('draft', 'planning', 'processing', 'review', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('character', 'digital_human', 'product', 'brand', 'scene', 'prop', 'costume', 'image', 'video', 'audio', 'voice', 'music', 'logo', 'font');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('active', 'draft', 'archived');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'running', 'waiting_user', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "TaskRisk" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('pending', 'running', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "WorkflowOrigin" AS ENUM ('builtin', 'agent_planned', 'user');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'agent', 'system', 'tool');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('text', 'plan', 'result_card', 'confirmation_request', 'progress', 'error');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('owner', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "OutputType" AS ENUM ('image', 'video', 'audio', 'subtitle', 'project', 'text');

-- CreateEnum
CREATE TYPE "SkillAccessTier" AS ENUM ('free', 'pro', 'enterprise');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('free', 'professional', 'enterprise');

-- CreateEnum
CREATE TYPE "ModelProviderKind" AS ENUM ('openai_compatible', 'anthropic_compatible', 'gemini_compatible', 'custom');

-- CreateEnum
CREATE TYPE "ModelCapability" AS ENUM ('text', 'script', 'image', 'image_edit', 'video', 'video_extend', 'audio', 'voice', 'music', 'digital_human', 'subtitle', 'embedding');

-- CreateEnum
CREATE TYPE "ModelTaskStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "TaskQueue" AS ENUM ('ai_llm', 'ai_image', 'ai_video', 'ai_audio', 'ai_digital_human', 'ai_render', 'asset');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "planTier" "PlanTier" NOT NULL DEFAULT 'free',
    "planExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "memory" JSONB NOT NULL DEFAULT '{}',
    "ownerId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL DEFAULT 'editor',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ContentType" NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "workflowId" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_versions" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changelog" TEXT NOT NULL DEFAULT '',
    "sessionId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "contentId" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "agentState" TEXT NOT NULL DEFAULT 'idle',
    "status" "SessionStatus" NOT NULL DEFAULT 'active',
    "contextSnapshot" JSONB NOT NULL DEFAULT '{}',
    "modelId" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL DEFAULT '',
    "payload" JSONB,
    "toolCalls" JSONB,
    "taskId" TEXT,
    "tokens" INTEGER,
    "modelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "files" JSONB NOT NULL DEFAULT '[]',
    "coverUrl" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'active',
    "sourceContentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_versions" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changelog" TEXT NOT NULL DEFAULT '',
    "sessionId" TEXT,
    "messageId" TEXT,
    "modelId" TEXT,
    "prompt" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_references" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "refPath" TEXT,
    "projectId" TEXT,
    "contentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "category" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inputSchema" JSONB NOT NULL DEFAULT '{}',
    "outputSchema" JSONB NOT NULL DEFAULT '{}',
    "risk" "TaskRisk" NOT NULL DEFAULT 'low',
    "accessTier" "SkillAccessTier" NOT NULL DEFAULT 'free',
    "estimatedSeconds" INTEGER NOT NULL DEFAULT 0,
    "cancellable" BOOLEAN NOT NULL DEFAULT true,
    "retryable" BOOLEAN NOT NULL DEFAULT true,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userHint" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_executions" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "projectId" TEXT,
    "contentId" TEXT,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "modelId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "origin" "WorkflowOrigin" NOT NULL DEFAULT 'builtin',
    "nodes" JSONB NOT NULL DEFAULT '[]',
    "edges" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentId" TEXT,
    "sessionId" TEXT,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL DEFAULT '{}',
    "state" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "currentLayer" INTEGER NOT NULL DEFAULT 0,
    "totalLayers" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentId" TEXT,
    "sessionId" TEXT,
    "skillId" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "risk" "TaskRisk" NOT NULL DEFAULT 'low',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "errorMessage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "progressMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "idempotencyKey" TEXT,
    "workflowRunId" TEXT,
    "workflowNodeKey" TEXT,
    "jobId" TEXT,
    "queueName" "TaskQueue",
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_leases" (
    "taskId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "leaseVersion" INTEGER NOT NULL DEFAULT 1,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_leases_pkey" PRIMARY KEY ("taskId")
);

-- CreateTable
CREATE TABLE "task_attempts" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'running',
    "modelId" TEXT,
    "providerId" TEXT,
    "workerId" TEXT,
    "leaseVersion" INTEGER,
    "error" TEXT,
    "usage" JSONB,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "task_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_task_steps" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "modelId" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_task_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "kind" "ModelProviderKind" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "apiKeyMask" TEXT NOT NULL DEFAULT '',
    "headers" JSONB NOT NULL DEFAULT '{}',
    "concurrency" INTEGER NOT NULL DEFAULT 4,
    "rateLimitPerMinute" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "health" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "models" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "capabilities" "ModelCapability"[] DEFAULT ARRAY[]::"ModelCapability"[],
    "priority" INTEGER NOT NULL DEFAULT 100,
    "supportsStreaming" BOOLEAN NOT NULL DEFAULT false,
    "supportsAsync" BOOLEAN NOT NULL DEFAULT false,
    "contextWindow" INTEGER,
    "maxOutputTokens" INTEGER,
    "supportedSizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxDurationSeconds" INTEGER,
    "unitCost" TEXT,
    "defaultParams" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_tasks" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "taskId" TEXT,
    "skillId" TEXT,
    "capability" "ModelCapability" NOT NULL,
    "status" "ModelTaskStatus" NOT NULL DEFAULT 'queued',
    "prompt" TEXT NOT NULL DEFAULT '',
    "params" JSONB NOT NULL DEFAULT '{}',
    "externalId" TEXT,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "usage" JSONB,
    "costEstimate" TEXT,
    "attemptChain" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "model_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outputs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentId" TEXT,
    "name" TEXT NOT NULL,
    "type" "OutputType" NOT NULL,
    "assetId" TEXT,
    "storage" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "projects_ownerId_idx" ON "projects"("ownerId");

-- CreateIndex
CREATE INDEX "projects_updatedAt_idx" ON "projects"("updatedAt");

-- CreateIndex
CREATE INDEX "project_members_userId_idx" ON "project_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");

-- CreateIndex
CREATE INDEX "contents_projectId_status_idx" ON "contents"("projectId", "status");

-- CreateIndex
CREATE INDEX "contents_projectId_type_idx" ON "contents"("projectId", "type");

-- CreateIndex
CREATE INDEX "contents_workflowId_idx" ON "contents"("workflowId");

-- CreateIndex
CREATE INDEX "content_versions_contentId_createdAt_idx" ON "content_versions"("contentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_contentId_version_key" ON "content_versions"("contentId", "version");

-- CreateIndex
CREATE INDEX "sessions_projectId_createdAt_idx" ON "sessions"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "sessions_contentId_idx" ON "sessions"("contentId");

-- CreateIndex
CREATE INDEX "messages_sessionId_createdAt_idx" ON "messages"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_taskId_idx" ON "messages"("taskId");

-- CreateIndex
CREATE INDEX "assets_projectId_type_idx" ON "assets"("projectId", "type");

-- CreateIndex
CREATE INDEX "assets_projectId_status_idx" ON "assets"("projectId", "status");

-- CreateIndex
CREATE INDEX "assets_sourceContentId_idx" ON "assets"("sourceContentId");

-- CreateIndex
CREATE UNIQUE INDEX "assets_projectId_slug_key" ON "assets"("projectId", "slug");

-- CreateIndex
CREATE INDEX "asset_versions_assetId_createdAt_idx" ON "asset_versions"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "asset_versions_assetId_version_key" ON "asset_versions"("assetId", "version");

-- CreateIndex
CREATE INDEX "asset_references_refType_refId_idx" ON "asset_references"("refType", "refId");

-- CreateIndex
CREATE INDEX "asset_references_contentId_idx" ON "asset_references"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_references_assetId_refType_refId_refPath_key" ON "asset_references"("assetId", "refType", "refId", "refPath");

-- CreateIndex
CREATE INDEX "skills_category_idx" ON "skills"("category");

-- CreateIndex
CREATE INDEX "skills_hidden_idx" ON "skills"("hidden");

-- CreateIndex
CREATE INDEX "skill_executions_taskId_idx" ON "skill_executions"("taskId");

-- CreateIndex
CREATE INDEX "skill_executions_skillId_createdAt_idx" ON "skill_executions"("skillId", "createdAt");

-- CreateIndex
CREATE INDEX "skill_executions_projectId_idx" ON "skill_executions"("projectId");

-- CreateIndex
CREATE INDEX "workflows_projectId_type_idx" ON "workflows"("projectId", "type");

-- CreateIndex
CREATE INDEX "workflows_isTemplate_type_idx" ON "workflows"("isTemplate", "type");

-- CreateIndex
CREATE INDEX "workflow_runs_projectId_status_idx" ON "workflow_runs"("projectId", "status");

-- CreateIndex
CREATE INDEX "workflow_runs_contentId_idx" ON "workflow_runs"("contentId");

-- CreateIndex
CREATE INDEX "workflow_runs_workflowId_idx" ON "workflow_runs"("workflowId");

-- CreateIndex
CREATE INDEX "agent_tasks_projectId_status_idx" ON "agent_tasks"("projectId", "status");

-- CreateIndex
CREATE INDEX "agent_tasks_contentId_idx" ON "agent_tasks"("contentId");

-- CreateIndex
CREATE INDEX "agent_tasks_sessionId_idx" ON "agent_tasks"("sessionId");

-- CreateIndex
CREATE INDEX "agent_tasks_skillId_idx" ON "agent_tasks"("skillId");

-- CreateIndex
CREATE INDEX "agent_tasks_status_createdAt_idx" ON "agent_tasks"("status", "createdAt");

-- CreateIndex
CREATE INDEX "agent_tasks_workflowRunId_idx" ON "agent_tasks"("workflowRunId");

-- CreateIndex
CREATE INDEX "agent_tasks_queueName_status_idx" ON "agent_tasks"("queueName", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tasks_projectId_idempotencyKey_key" ON "agent_tasks"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "task_leases_leaseUntil_idx" ON "task_leases"("leaseUntil");

-- CreateIndex
CREATE INDEX "task_leases_workerId_idx" ON "task_leases"("workerId");

-- CreateIndex
CREATE INDEX "task_attempts_taskId_startedAt_idx" ON "task_attempts"("taskId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_attempts_taskId_attempt_key" ON "task_attempts"("taskId", "attempt");

-- CreateIndex
CREATE INDEX "agent_task_steps_taskId_createdAt_idx" ON "agent_task_steps"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_task_steps_taskId_index_key" ON "agent_task_steps"("taskId", "index");

-- CreateIndex
CREATE INDEX "model_providers_userId_enabled_idx" ON "model_providers"("userId", "enabled");

-- CreateIndex
CREATE INDEX "models_enabled_priority_idx" ON "models"("enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "models_providerId_modelKey_key" ON "models"("providerId", "modelKey");

-- CreateIndex
CREATE INDEX "model_tasks_taskId_idx" ON "model_tasks"("taskId");

-- CreateIndex
CREATE INDEX "model_tasks_modelId_createdAt_idx" ON "model_tasks"("modelId", "createdAt");

-- CreateIndex
CREATE INDEX "model_tasks_status_idx" ON "model_tasks"("status");

-- CreateIndex
CREATE INDEX "outputs_projectId_createdAt_idx" ON "outputs"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "outputs_contentId_idx" ON "outputs"("contentId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_sourceContentId_fkey" FOREIGN KEY ("sourceContentId") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_executions" ADD CONSTRAINT "skill_executions_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_executions" ADD CONSTRAINT "skill_executions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_executions" ADD CONSTRAINT "skill_executions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_executions" ADD CONSTRAINT "skill_executions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "models" ADD CONSTRAINT "models_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "model_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_tasks" ADD CONSTRAINT "model_tasks_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "model_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_tasks" ADD CONSTRAINT "model_tasks_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_tasks" ADD CONSTRAINT "model_tasks_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
