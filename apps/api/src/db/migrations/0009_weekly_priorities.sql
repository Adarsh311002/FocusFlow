CREATE TABLE "weekly_priorities" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"position" smallint NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_weekly_priorities" PRIMARY KEY("id"),
	CONSTRAINT "ck_weekly_priorities_position" CHECK ("weekly_priorities"."position" BETWEEN 1 AND 3),
	CONSTRAINT "ck_weekly_priorities_week_start_monday" CHECK (extract(isodow from "weekly_priorities"."week_start") = 1)
);
--> statement-breakpoint
ALTER TABLE "weekly_priorities" ADD CONSTRAINT "fk_weekly_priorities_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_priorities" ADD CONSTRAINT "fk_weekly_priorities_task_id" FOREIGN KEY ("task_id","user_id") REFERENCES "public"."tasks"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_weekly_priorities_user_week_position" ON "weekly_priorities" USING btree ("user_id","week_start","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_weekly_priorities_user_week_task" ON "weekly_priorities" USING btree ("user_id","week_start","task_id");