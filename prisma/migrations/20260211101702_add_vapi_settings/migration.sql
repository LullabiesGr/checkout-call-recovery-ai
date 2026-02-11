/*
  Warnings:

  - You are about to drop the column `recoveredAmount` on the `Checkout` table. All the data in the column will be lost.
  - You are about to drop the column `recoveredAt` on the `Checkout` table. All the data in the column will be lost.
  - You are about to drop the column `recoveredOrderId` on the `Checkout` table. All the data in the column will be lost.
  - You are about to drop the column `prePrompt` on the `Settings` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Checkout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "token" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "value" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "abandonedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "raw" TEXT,
    "customerName" TEXT,
    "itemsJson" TEXT
);
INSERT INTO "new_Checkout" ("abandonedAt", "checkoutId", "createdAt", "currency", "customerName", "email", "id", "itemsJson", "phone", "raw", "shop", "status", "token", "updatedAt", "value") SELECT "abandonedAt", "checkoutId", "createdAt", "currency", "customerName", "email", "id", "itemsJson", "phone", "raw", "shop", "status", "token", "updatedAt", "value" FROM "Checkout";
DROP TABLE "Checkout";
ALTER TABLE "new_Checkout" RENAME TO "Checkout";
CREATE INDEX "Checkout_shop_status_createdAt_idx" ON "Checkout"("shop", "status", "createdAt");
CREATE UNIQUE INDEX "Checkout_shop_checkoutId_key" ON "Checkout"("shop", "checkoutId");
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
    "vapiAssistantId" TEXT,
    "vapiPhoneNumberId" TEXT,
    "userPrompt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("callWindowEnd", "callWindowStart", "createdAt", "currency", "delayMinutes", "enabled", "id", "maxAttempts", "minOrderValue", "retryMinutes", "shop", "updatedAt", "userPrompt", "vapiAssistantId", "vapiPhoneNumberId") SELECT "callWindowEnd", "callWindowStart", "createdAt", "currency", "delayMinutes", "enabled", "id", "maxAttempts", "minOrderValue", "retryMinutes", "shop", "updatedAt", "userPrompt", "vapiAssistantId", "vapiPhoneNumberId" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
