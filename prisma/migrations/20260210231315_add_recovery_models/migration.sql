/*
  Warnings:

  - Added the required column `phone` to the `CallJob` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `CallJob` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Checkout` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "checkoutId" TEXT,
    "checkoutToken" TEXT,
    "total" REAL,
    "currency" TEXT,
    "financial" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" TEXT
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "delayMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "retryMinutes" INTEGER NOT NULL DEFAULT 180,
    "minOrderValue" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CallJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerCallId" TEXT,
    "outcome" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CallJob" ("attempts", "checkoutId", "createdAt", "id", "scheduledFor", "shop", "status") SELECT "attempts", "checkoutId", "createdAt", "id", "scheduledFor", "shop", "status" FROM "CallJob";
DROP TABLE "CallJob";
ALTER TABLE "new_CallJob" RENAME TO "CallJob";
CREATE INDEX "CallJob_shop_status_scheduledFor_idx" ON "CallJob"("shop", "status", "scheduledFor");
CREATE INDEX "CallJob_shop_checkoutId_idx" ON "CallJob"("shop", "checkoutId");
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
    "raw" TEXT
);
INSERT INTO "new_Checkout" ("checkoutId", "createdAt", "currency", "id", "shop", "value") SELECT "checkoutId", "createdAt", "currency", "id", "shop", "value" FROM "Checkout";
DROP TABLE "Checkout";
ALTER TABLE "new_Checkout" RENAME TO "Checkout";
CREATE INDEX "Checkout_shop_status_createdAt_idx" ON "Checkout"("shop", "status", "createdAt");
CREATE UNIQUE INDEX "Checkout_shop_checkoutId_key" ON "Checkout"("shop", "checkoutId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Order_shop_createdAt_idx" ON "Order"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shop_orderId_key" ON "Order"("shop", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
