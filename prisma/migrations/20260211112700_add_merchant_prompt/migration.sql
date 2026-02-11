/*
  Warnings:

  - You are about to drop the column `userPrompt` on the `Settings` table. All the data in the column will be lost.
  - You are about to drop the column `vapiAssistantId` on the `Settings` table. All the data in the column will be lost.
  - You are about to drop the column `vapiPhoneNumberId` on the `Settings` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "delayMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "retryMinutes" INTEGER NOT NULL DEFAULT 180,
    "minOrderValue" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "callWindowStart" TEXT NOT NULL DEFAULT '09:00',
    "callWindowEnd" TEXT NOT NULL DEFAULT '19:00',
    "merchantPrompt" TEXT DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("callWindowEnd", "callWindowStart", "createdAt", "currency", "delayMinutes", "enabled", "id", "maxAttempts", "minOrderValue", "retryMinutes", "shop", "updatedAt") SELECT "callWindowEnd", "callWindowStart", "createdAt", "currency", "delayMinutes", "enabled", "id", "maxAttempts", "minOrderValue", "retryMinutes", "shop", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
