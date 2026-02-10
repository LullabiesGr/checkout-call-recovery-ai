-- CreateTable
CREATE TABLE "Checkout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CallJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Checkout_shop_checkoutId_idx" ON "Checkout"("shop", "checkoutId");

-- CreateIndex
CREATE INDEX "CallJob_shop_status_scheduledFor_idx" ON "CallJob"("shop", "status", "scheduledFor");
