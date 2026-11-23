ALTER TABLE "focus_sessions" DROP CONSTRAINT "ck_focus_sessions_abandon_reason";--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD COLUMN "focus_run_id" uuid;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "fk_focus_sessions_room_id" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_focus_sessions_room_run_in_progress" ON "focus_sessions" USING btree ("room_id","focus_run_id") WHERE "focus_sessions"."status" = 'in_progress';--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_room_run" CHECK (("focus_sessions"."room_id" IS NULL) = ("focus_sessions"."focus_run_id" IS NULL));--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_running_since_solo" CHECK ("focus_sessions"."room_id" IS NULL OR "focus_sessions"."running_since" IS NULL);--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "ck_focus_sessions_abandon_reason" CHECK ("focus_sessions"."abandon_reason" IN ('stopped', 'grace_expired', 'expired', 'opted_out', 'left_room', 'removed', 'reset', 'phase_changed', 'timer_lost'));