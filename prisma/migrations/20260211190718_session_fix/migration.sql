-- AlterTable 
ALTER TABLE "Session" ADD COLUMN "refreshToken" TEXT,
ADD COLUMN "refreshTokenExpires" TIMESTAMP(3);

-- CreateIndex (idempotent)
CREATE INDEX "Session_shop_idx" ON "Session"("shop");
