CREATE TABLE "push_subscriptions" (
  "endpoint" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "expiration_time" INTEGER,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE INDEX "idx_push_subscriptions_user_id" ON "push_subscriptions" ("user_id");
