ALTER TABLE "focus_sessions" DROP CONSTRAINT "ck_focus_sessions_abandon_reason";--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "deep_focus" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "distractions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "pause_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_deep_focus_solo" CHECK (NOT "focus_sessions"."deep_focus" OR "focus_sessions"."room_id" IS NULL);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_focus_broken" CHECK ("focus_sessions"."abandon_reason" IS DISTINCT FROM 'focus_broken' OR "focus_sessions"."deep_focus");--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_distractions" CHECK ("focus_sessions"."distractions" BETWEEN 0 AND 1000);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_pause_count" CHECK ("focus_sessions"."pause_count" >= 0);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_abandon_reason" CHECK ("focus_sessions"."abandon_reason" IN ('stopped', 'grace_expired', 'expired', 'opted_out', 'left_room', 'removed', 'reset', 'phase_changed', 'timer_lost', 'focus_broken'));