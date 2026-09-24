CREATE TABLE "auth_identities" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"email_at_link" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_auth_identities" PRIMARY KEY("id"),
	CONSTRAINT "ck_auth_identities_provider" CHECK ("auth_identities"."provider" IN ('google'))
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"current_token_hash" text NOT NULL,
	"previous_token_hash" text,
	"previous_valid_until" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_auth_sessions" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"display_name" text NOT NULL,
	"password_hash" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_users" PRIMARY KEY("id"),
	CONSTRAINT "ck_users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "ck_users_display_name_length" CHECK (char_length("users"."display_name") BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "fk_auth_identities_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "fk_auth_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_auth_identities_provider_subject" ON "auth_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "ix_auth_identities_user_id" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_sessions_user_id" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_email" ON "users" USING btree ("email");