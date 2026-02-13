-- Session
alter table "Session" add column if not exists "refreshToken" text;
alter table "Session" add column if not exists "refreshTokenExpires" timestamp(3);
create index if not exists "Session_shop_idx" on "Session" ("shop");

-- CallJob
alter table "CallJob" add column if not exists "endedReason" text;
alter table "CallJob" add column if not exists "transcript" text;
alter table "CallJob" add column if not exists "recordingUrl" text;

alter table "CallJob" add column if not exists "sentiment" text;
alter table "CallJob" add column if not exists "tagsCsv" text;
alter table "CallJob" add column if not exists "reason" text;
alter table "CallJob" add column if not exists "nextAction" text;
alter table "CallJob" add column if not exists "followUp" text;
alter table "CallJob" add column if not exists "analysisJson" text;

alter table "CallJob" add column if not exists "attributedAt" timestamp(3);
alter table "CallJob" add column if not exists "attributedOrderId" text;
alter table "CallJob" add column if not exists "attributedAmount" double precision;
create index if not exists "CallJob_attributedAt_idx" on "CallJob" ("attributedAt");

-- Checkout
alter table "Checkout" add column if not exists "recoveredAt" timestamp(3);
alter table "Checkout" add column if not exists "recoveredOrderId" text;
alter table "Checkout" add column if not exists "recoveredAmount" double precision;

create index if not exists "Checkout_recoveredAt_idx" on "Checkout" ("recoveredAt");
create index if not exists "Checkout_shop_status_createdAt_idx" on "Checkout" ("shop","status","createdAt");
