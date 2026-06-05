CREATE TABLE "push_subscriptions" (
  "endpoint" VARCHAR(768) PRIMARY KEY,
  "user_id" VARCHAR(255) NOT NULL,
  "p256dh" VARCHAR(100) NOT NULL,
  "auth" VARCHAR(50) NOT NULL,
  "expiration_time" BIGINT,
  "created_at" TIMESTAMP NOT NULL,
  "updated_at" TIMESTAMP NOT NULL
);
CREATE INDEX "idx_push_subscriptions_user_id" ON "push_subscriptions" ("user_id");
