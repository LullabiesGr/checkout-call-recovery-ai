-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('OPEN', 'ABANDONED', 'CONVERTED', 'RECOVERED');

-- CreateEnum
CREATE TYPE "CallJobStatus" AS ENUM ('QUEUED', 'CALLING', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "Checkout" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "token" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "value" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'OPEN',
    "abandonedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "raw" TEXT,
    "customerName" TEXT,
    "itemsJson" TEXT,

    CONSTRAINT "Checkout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "checkoutId" TEXT,
    "checkoutToken" TEXT,
    "total" DOUBLE PRECISION,
    "currency" TEXT,
    "financial" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "CallJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerCallId" TEXT,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "delayMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "retryMinutes" INTEGER NOT NULL DEFAULT 180,
    "minOrderValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "callWindowStart" TEXT NOT NULL DEFAULT '09:00',
    "callWindowEnd" TEXT NOT NULL DEFAULT '19:00',
    "merchantPrompt" TEXT DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Checkout_shop_status_createdAt_idx" ON "Checkout"("shop", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Checkout_shop_checkoutId_key" ON "Checkout"("shop", "checkoutId");

-- CreateIndex
CREATE INDEX "Order_shop_createdAt_idx" ON "Order"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shop_orderId_key" ON "Order"("shop", "orderId");

-- CreateIndex
CREATE INDEX "CallJob_shop_status_scheduledFor_idx" ON "CallJob"("shop", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "CallJob_shop_checkoutId_idx" ON "CallJob"("shop", "checkoutId");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
