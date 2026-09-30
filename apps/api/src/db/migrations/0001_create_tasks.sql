CREATE TABLE "tasks" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_tasks" PRIMARY KEY("id"),
	CONSTRAINT "uq_tasks_id_user_id" UNIQUE("id","user_id"),
	CONSTRAINT "ck_tasks_title_length" CHECK (char_length("tasks"."title") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "current_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_tasks_user_id_id" ON "tasks" USING btree ("user_id","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "fk_users_current_task_id" FOREIGN KEY ("current_task_id","id") REFERENCES "public"."tasks"("id","user_id") ON DELETE no action ON UPDATE no action;