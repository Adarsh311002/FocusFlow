ALTER TABLE "users" ADD COLUMN "avatar_preset" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_session_seconds" integer DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_avatar_preset" CHECK ("users"."avatar_preset" IN ('monkey', 'sloth', 'toucan', 'frog', 'owl', 'butterfly', 'jaguar'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_default_session_seconds" CHECK ("users"."default_session_seconds" BETWEEN 60 AND 14400);