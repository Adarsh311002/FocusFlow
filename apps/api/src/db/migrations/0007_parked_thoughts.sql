CREATE TABLE "parked_thoughts" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_parked_thoughts" PRIMARY KEY("id"),
	CONSTRAINT "ck_parked_thoughts_body_length" CHECK (char_length("parked_thoughts"."body") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "parked_thoughts" ADD CONSTRAINT "fk_parked_thoughts_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parked_thoughts" ADD CONSTRAINT "fk_parked_thoughts_session_id" FOREIGN KEY ("session_id") REFERENCES "public"."focus_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_parked_thoughts_user_id_id" ON "parked_thoughts" USING btree ("user_id","id" DESC NULLS LAST);