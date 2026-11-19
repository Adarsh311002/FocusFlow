CREATE TABLE "room_blocks" (
	"id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_room_blocks" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_goal_seconds" integer DEFAULT 7200 NOT NULL;--> statement-breakpoint
ALTER TABLE "room_blocks" ADD CONSTRAINT "fk_room_blocks_room_id" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_blocks" ADD CONSTRAINT "fk_room_blocks_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_room_blocks_room_id_user_id" ON "room_blocks" USING btree ("room_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_room_blocks_user_id" ON "room_blocks" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_daily_goal_seconds" CHECK ("users"."daily_goal_seconds" BETWEEN 300 AND 43200);