CREATE TABLE "focus_sessions" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid,
	"status" text NOT NULL,
	"abandon_reason" text,
	"planned_seconds" integer NOT NULL,
	"focused_seconds" integer DEFAULT 0 NOT NULL,
	"running_since" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_focus_sessions" PRIMARY KEY("id"),
	CONSTRAINT "ck_focus_sessions_status" CHECK ("focus_sessions"."status" IN ('in_progress', 'completed', 'abandoned')),
	CONSTRAINT "ck_focus_sessions_abandon_reason" CHECK ("focus_sessions"."abandon_reason" IN ('stopped', 'grace_expired', 'expired')),
	CONSTRAINT "ck_focus_sessions_planned_seconds" CHECK ("focus_sessions"."planned_seconds" BETWEEN 60 AND 14400),
	CONSTRAINT "ck_focus_sessions_focused_seconds" CHECK ("focus_sessions"."focused_seconds" BETWEEN 0 AND "focus_sessions"."planned_seconds"),
	CONSTRAINT "ck_focus_sessions_ended_at" CHECK (("focus_sessions"."status" = 'in_progress') = ("focus_sessions"."ended_at" IS NULL)),
	CONSTRAINT "ck_focus_sessions_abandon_reason_presence" CHECK (("focus_sessions"."status" = 'abandoned') = ("focus_sessions"."abandon_reason" IS NOT NULL)),
	CONSTRAINT "ck_focus_sessions_running_since" CHECK ("focus_sessions"."running_since" IS NULL OR "focus_sessions"."status" = 'in_progress'),
	CONSTRAINT "ck_focus_sessions_ended_after_started" CHECK ("focus_sessions"."ended_at" IS NULL OR "focus_sessions"."ended_at" >= "focus_sessions"."started_at"),
	CONSTRAINT "ck_focus_sessions_running_since_after_started" CHECK ("focus_sessions"."running_since" IS NULL OR "focus_sessions"."running_since" >= "focus_sessions"."started_at"),
	CONSTRAINT "ck_focus_sessions_completed_focused" CHECK ("focus_sessions"."status" <> 'completed' OR "focus_sessions"."focused_seconds" = "focus_sessions"."planned_seconds")
);
--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "fk_focus_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "fk_focus_sessions_task_id" FOREIGN KEY ("task_id","user_id") REFERENCES "public"."tasks"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_focus_sessions_user_id_in_progress" ON "focus_sessions" USING btree ("user_id") WHERE "focus_sessions"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "ix_focus_sessions_user_id_started_at" ON "focus_sessions" USING btree ("user_id","started_at" DESC NULLS LAST);