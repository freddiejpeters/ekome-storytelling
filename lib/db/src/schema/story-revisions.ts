import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { stories } from "./stories";

export const storyRevisions = pgTable("story_revisions", {
  id: serial("id").primaryKey(),
  storyId: integer("story_id")
    .notNull()
    .references(() => stories.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  perspective: text("perspective").notNull().default("first_person"),
  tone: text("tone").notNull().default("reflective"),
  format: text("format").notNull().default("journal_entry"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type StoryRevision = typeof storyRevisions.$inferSelect;
