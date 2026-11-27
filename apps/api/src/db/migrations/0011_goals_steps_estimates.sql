CREATE TABLE "goals" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"why" text,
	"target_date" date,
	"color" text DEFAULT 'leaf' NOT NULL,
	"completed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_goals" PRIMARY KEY("id"),
	CONSTRAINT "uq_goals_id_user_id" UNIQUE("id","user_id"),
	CONSTRAINT "ck_goals_title_length" CHECK (char_length("goals"."title") BETWEEN 1 AND 80),
	CONSTRAINT "ck_goals_why_length" CHECK ("goals"."why" IS NULL OR char_length("goals"."why") BETWEEN 1 AND 280),
	CONSTRAINT "ck_goals_color" CHECK ("goals"."color" IN ('leaf', 'moss', 'fern', 'amber', 'berry', 'sky')),
	CONSTRAINT "ck_goals_one_end" CHECK ("goals"."completed_at" IS NULL OR "goals"."archived_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "task_steps" (
	"id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_task_steps" PRIMARY KEY("id"),
	CONSTRAINT "ck_task_steps_title_length" CHECK (char_length("task_steps"."title") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "estimated_sessions" smallint;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "fk_goals_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "fk_task_steps_task_id" FOREIGN KEY ("task_id","user_id") REFERENCES "public"."tasks"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "fk_task_steps_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_goals_user_id_id" ON "goals" USING btree ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_task_steps_task_id_id" ON "task_steps" USING btree ("task_id","id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_goal_id" FOREIGN KEY ("goal_id","user_id") REFERENCES "public"."goals"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_tasks_goal_id" ON "tasks" USING btree ("goal_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "ck_tasks_estimated_sessions" CHECK ("tasks"."estimated_sessions" IS NULL OR "tasks"."estimated_sessions" BETWEEN 1 AND 20);