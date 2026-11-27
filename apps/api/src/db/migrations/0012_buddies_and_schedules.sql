CREATE TABLE "buddy_links" (
	"id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"addressee_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_buddy_links" PRIMARY KEY("id"),
	CONSTRAINT "ck_buddy_links_not_self" CHECK ("buddy_links"."requester_id" <> "buddy_links"."addressee_id")
);
--> statement-breakpoint
CREATE TABLE "room_schedules" (
	"id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" smallint NOT NULL,
	"repeats_weekly" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_room_schedules" PRIMARY KEY("id"),
	CONSTRAINT "ck_room_schedules_title_length" CHECK (char_length("room_schedules"."title") BETWEEN 1 AND 60),
	CONSTRAINT "ck_room_schedules_duration" CHECK ("room_schedules"."duration_minutes" BETWEEN 5 AND 240)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "buddy_code" text;--> statement-breakpoint
ALTER TABLE "buddy_links" ADD CONSTRAINT "fk_buddy_links_requester_id" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buddy_links" ADD CONSTRAINT "fk_buddy_links_addressee_id" FOREIGN KEY ("addressee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_schedules" ADD CONSTRAINT "fk_room_schedules_room_id" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_schedules" ADD CONSTRAINT "fk_room_schedules_created_by" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_buddy_links_pair" ON "buddy_links" USING btree (least("requester_id", "addressee_id"),greatest("requester_id", "addressee_id"));--> statement-breakpoint
CREATE INDEX "ix_buddy_links_addressee_id" ON "buddy_links" USING btree ("addressee_id");--> statement-breakpoint
CREATE INDEX "ix_buddy_links_requester_id" ON "buddy_links" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "ix_room_schedules_room_id" ON "room_schedules" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_buddy_code" ON "users" USING btree ("buddy_code");