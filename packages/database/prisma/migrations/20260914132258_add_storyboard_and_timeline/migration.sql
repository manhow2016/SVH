-- CreateEnum
CREATE TYPE "ShotStatus" AS ENUM ('draft', 'generating', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "TimelineTrackKind" AS ENUM ('video', 'audio', 'subtitle');

-- CreateEnum
CREATE TYPE "DirectorActor" AS ENUM ('user', 'agent');

-- CreateEnum
CREATE TYPE "DirectorActionType" AS ENUM ('create_project', 'update_project', 'create_story', 'update_story', 'create_script', 'update_script', 'create_asset', 'update_asset', 'delete_asset', 'create_shot', 'update_shot', 'delete_shot', 'reorder_shots', 'generate_image', 'generate_video', 'generate_audio', 'create_timeline', 'update_timeline', 'run_workflow', 'run_task', 'validate_project', 'repair_project');

-- CreateEnum
CREATE TYPE "DirectorActionStatus" AS ENUM ('proposed', 'awaiting_confirmation', 'approved', 'rejected', 'executing', 'executed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "storyboard_shots" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "episodeId" TEXT,
    "index" INTEGER NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "camera" JSONB NOT NULL DEFAULT '{}',
    "emotion" TEXT,
    "dialogue" JSONB NOT NULL DEFAULT '[]',
    "imageAssetId" TEXT,
    "videoAssetId" TEXT,
    "status" "ShotStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storyboard_shots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_tracks" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "kind" "TimelineTrackKind" NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timeline_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_clips" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "shotId" TEXT,
    "assetId" TEXT,
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timeline_clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "director_actions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentId" TEXT,
    "sessionId" TEXT,
    "actor" "DirectorActor" NOT NULL,
    "type" "DirectorActionType" NOT NULL,
    "targets" JSONB NOT NULL DEFAULT '[]',
    "changes" JSONB NOT NULL DEFAULT '{}',
    "status" "DirectorActionStatus" NOT NULL DEFAULT 'proposed',
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "batchSize" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "director_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storyboard_shots_contentId_status_idx" ON "storyboard_shots"("contentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "storyboard_shots_contentId_index_key" ON "storyboard_shots"("contentId", "index");

-- CreateIndex
CREATE INDEX "timeline_tracks_contentId_kind_idx" ON "timeline_tracks"("contentId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "timeline_tracks_contentId_order_key" ON "timeline_tracks"("contentId", "order");

-- CreateIndex
CREATE INDEX "timeline_clips_trackId_startSeconds_idx" ON "timeline_clips"("trackId", "startSeconds");

-- CreateIndex
CREATE INDEX "director_actions_projectId_status_idx" ON "director_actions"("projectId", "status");

-- CreateIndex
CREATE INDEX "director_actions_sessionId_idx" ON "director_actions"("sessionId");

-- AddForeignKey
ALTER TABLE "storyboard_shots" ADD CONSTRAINT "storyboard_shots_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_shots" ADD CONSTRAINT "storyboard_shots_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_shots" ADD CONSTRAINT "storyboard_shots_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_tracks" ADD CONSTRAINT "timeline_tracks_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "timeline_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "storyboard_shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "director_actions" ADD CONSTRAINT "director_actions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "director_actions" ADD CONSTRAINT "director_actions_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "director_actions" ADD CONSTRAINT "director_actions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 片段必须且只能有一个来源。
-- Prisma schema 无法表达 CHECK，因此手写在这里；domain 侧另有判别联合，
-- 两层护栏缺一不可（绕过仓储的直接写入只能靠这一条挡住）。
ALTER TABLE "timeline_clips"
  ADD CONSTRAINT "timeline_clips_exactly_one_source_check"
  CHECK ((("shotId" IS NOT NULL)::int + ("assetId" IS NOT NULL)::int) = 1);
