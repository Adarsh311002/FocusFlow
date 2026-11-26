CREATE TABLE "ai_jobs" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"task_id" uuid,
	"week_start" date,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"source" text,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "pk_ai_jobs" PRIMARY KEY("id"),
	CONSTRAINT "ck_ai_jobs_kind" CHECK ("ai_jobs"."kind" IN ('first_step', 'weekly_reflection')),
	CONSTRAINT "ck_ai_jobs_status" CHECK ("ai_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "ck_ai_jobs_subject" CHECK (("ai_jobs"."kind" = 'first_step' AND "ai_jobs"."task_id" IS NOT NULL AND "ai_jobs"."week_start" IS NULL) OR ("ai_jobs"."kind" = 'weekly_reflection' AND "ai_jobs"."week_start" IS NOT NULL AND "ai_jobs"."task_id" IS NULL)),
	CONSTRAINT "ck_ai_jobs_outcome" CHECK (("ai_jobs"."status" = 'succeeded') = ("ai_jobs"."result" IS NOT NULL AND "ai_jobs"."source" IS NOT NULL) AND ("ai_jobs"."status" = 'failed') = ("ai_jobs"."failure" IS NOT NULL)),
	CONSTRAINT "ck_ai_jobs_source" CHECK ("ai_jobs"."source" IS NULL OR "ai_jobs"."source" IN ('model', 'mock')),
	CONSTRAINT "ck_ai_jobs_failure" CHECK ("ai_jobs"."failure" IS NULL OR "ai_jobs"."failure" IN ('unavailable', 'declined', 'invalid_output', 'timed_out'))
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "fk_ai_jobs_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "fk_ai_jobs_task_id_user_id" FOREIGN KEY ("task_id","user_id") REFERENCES "public"."tasks"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_jobs_user_id_kind_active" ON "ai_jobs" USING btree ("user_id","kind") WHERE "ai_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "ix_ai_jobs_user_id_kind_created_at" ON "ai_jobs" USING btree ("user_id","kind","created_at" DESC NULLS LAST);