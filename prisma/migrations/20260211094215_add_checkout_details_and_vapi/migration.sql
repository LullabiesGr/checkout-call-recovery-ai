-- AlterTable
ALTER TABLE "Checkout" ADD COLUMN "recoveredAmount" REAL;
ALTER TABLE "Checkout" ADD COLUMN "recoveredAt" DATETIME;
ALTER TABLE "Checkout" ADD COLUMN "recoveredOrderId" TEXT;

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
    "vapiAssistantId" TEXT,
    "vapiPhoneNumberId" TEXT,
    "prePrompt" TEXT NOT NULL DEFAULT 'You are a helpful sales recovery agent for an ecommerce store. You call customers who abandoned checkout. Be concise, polite, and aim to help them complete the purchase. Ask if they had issues with checkout/shipping/payment, offer help, and if interested send them back to checkout.',
    "userPrompt" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("callWindowEnd", "callWindowStart", "createdAt", "currency", "delayMinutes", "enabled", "id", "maxAttempts", "minOrderValue", "retryMinutes", "shop", "updatedAt") SELECT "callWindowEnd", "callWindowStart", "createdAt", "currency", "delayMinutes", "enabled", "id", "maxAttempts", "minOrderValue", "retryMinutes", "shop", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
