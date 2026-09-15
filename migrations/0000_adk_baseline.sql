-- adk — baseline 0000.
--
-- Collapsed from the central packages/db/code/drizzle/adk migrations 0000–0002 at the 2026-07
-- pre-production baseline reset (and co-located here from that central tree in the same change); see
-- packages/db/intent/discovery/2026-07-schema-layer-review.md. Hand-authored SQL (drizzle-kit
-- generation retired estate-wide); the Drizzle row-type binding stays central at @anima/db
-- (packages/db/code/src/schema/adk.ts) because @animahealth/adk is a publishable library whose
-- Postgres backends (src/gateway/postgres.ts, src/artifacts/postgres.ts) speak raw parameterized SQL
-- over the pg peer dependency. Rides the `factory` cell (dev-tier only: local `fab` + Neon; no
-- deployed root). No CREATE SCHEMA statement — the migration runner creates the schema before
-- applying a domain's journal (migrate-core.ts).
--
-- Design rules carried by this baseline:
--   * Multi-tenant isolation by app_name: processes are keyed (app_name, id), and every dependent
--     row (messages, artifact_versions) carries app_name and a composite FK back to its process —
--     two apps minting the same process id can never claim, consume, or delete each other's rows
--     (2026-07 review §6.8). ON DELETE CASCADE makes ProcessStore.delete() a one-statement erasure
--     that can never orphan messages or artifacts.
--   * Claim state is a real column: claimed_at (set by claimDue, cleared on revert/state change),
--     never a value smuggled into the metadata jsonb.
--   * status is the closed lifecycle vocabulary of gateway/types.ts ProcessStatus, CHECK-pinned.
--   * A sleeping agent is a database row (ADK runtime tenet 2): idx_processes_due is the partial
--     index that keeps claimDue cheap regardless of total process count, and
--     idx_processes_stale_claims does the same for revertStale's queued-claim scan — completed rows
--     are retained, so both scans need partial indexes to stay independent of table size.
CREATE TABLE "adk"."processes" (
	"id" text NOT NULL,
	"agent_name" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'sleeping' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"schedule" text,
	"next_wake_at" timestamp with time zone,
	"executor" text,
	"executor_config" jsonb,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"app_name" text NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "processes_app_name_id_pk" PRIMARY KEY("app_name","id"),
	CONSTRAINT "ck_processes_status" CHECK ("status" in ('sleeping', 'queued', 'running', 'completed'))
);
--> statement-breakpoint
CREATE INDEX "idx_processes_due" ON "adk"."processes" USING btree ("app_name","next_wake_at") WHERE "status" = 'sleeping' AND "paused" = false;
--> statement-breakpoint
CREATE INDEX "idx_processes_stale_claims" ON "adk"."processes" USING btree ("app_name","claimed_at") WHERE "status" = 'queued';
--> statement-breakpoint
CREATE TABLE "adk"."messages" (
	"id" text PRIMARY KEY NOT NULL,
	"process_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"author_id" text,
	"author_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"app_name" text NOT NULL,
	CONSTRAINT "messages_app_name_process_id_processes_app_name_id_fk" FOREIGN KEY ("app_name","process_id") REFERENCES "adk"."processes"("app_name","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "idx_messages_process" ON "adk"."messages" USING btree ("process_id");
--> statement-breakpoint
CREATE TABLE "adk"."artifact_versions" (
	"app_name" text NOT NULL,
	"process_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"mime_type" text NOT NULL,
	"data" bytea,
	"uri" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_app_name_process_id_name_version_pk" PRIMARY KEY("app_name","process_id","name","version"),
	CONSTRAINT "artifact_versions_app_name_process_id_processes_app_name_id_fk" FOREIGN KEY ("app_name","process_id") REFERENCES "adk"."processes"("app_name","id") ON DELETE cascade ON UPDATE no action
);
