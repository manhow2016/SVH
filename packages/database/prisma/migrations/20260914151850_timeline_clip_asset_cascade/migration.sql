-- DropForeignKey
ALTER TABLE "timeline_clips" DROP CONSTRAINT "timeline_clips_assetId_fkey";

-- AddForeignKey
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
