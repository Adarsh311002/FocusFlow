ALTER TABLE "focus_sessions" ADD COLUMN "check_in_outcome" text;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "check_in_note" text;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "share_intention" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_check_in_outcome" CHECK ("focus_sessions"."check_in_outcome" IN ('done', 'progress', 'stuck'));--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_check_in_presence" CHECK (("focus_sessions"."check_in_outcome" IS NULL) = ("focus_sessions"."checked_in_at" IS NULL));--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_check_in_note" CHECK ("focus_sessions"."check_in_note" IS NULL OR ("focus_sessions"."check_in_outcome" IS NOT NULL AND char_length("focus_sessions"."check_in_note") BETWEEN 1 AND 280));--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_check_in_ended" CHECK ("focus_sessions"."check_in_outcome" IS NULL OR "focus_sessions"."status" <> 'in_progress');--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_share_intention" CHECK (NOT "focus_sessions"."share_intention" OR ("focus_sessions"."room_id" IS NOT NULL AND "focus_sessions"."task_id" IS NOT NULL));