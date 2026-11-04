CREATE TABLE "room_members" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_room_members" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"host_id" uuid NOT NULL,
	"is_private" boolean NOT NULL,
	"focus_seconds" integer DEFAULT 1500 NOT NULL,
	"short_break_seconds" integer DEFAULT 300 NOT NULL,
	"long_break_seconds" integer DEFAULT 900 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_rooms" PRIMARY KEY("id"),
	CONSTRAINT "ck_rooms_code" CHECK ("rooms"."code" ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
	CONSTRAINT "ck_rooms_name" CHECK (char_length("rooms"."name") BETWEEN 1 AND 60),
	CONSTRAINT "ck_rooms_focus_seconds" CHECK ("rooms"."focus_seconds" BETWEEN 60 AND 14400),
	CONSTRAINT "ck_rooms_short_break_seconds" CHECK ("rooms"."short_break_seconds" BETWEEN 60 AND 3600),
	CONSTRAINT "ck_rooms_long_break_seconds" CHECK ("rooms"."long_break_seconds" BETWEEN 60 AND 7200)
);
--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "fk_room_members_room_id" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "fk_room_members_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "fk_rooms_host_id" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_room_members_user_id_joined_at" ON "room_members" USING btree ("user_id","joined_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rooms_code" ON "rooms" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ix_rooms_host_id" ON "rooms" USING btree ("host_id");