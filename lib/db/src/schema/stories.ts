import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

export const stories = pgTable("stories", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  title: text("title"),
  content: text("content").notNull(),
  perspective: text("perspective").notNull().default("first_person"),
  tone: text("tone").notNull().default("reflective"),
  format: text("format").notNull().default("journal_entry"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export const insertStorySchema = createInsertSchema(stories).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Story = typeof stories.$inferSelect;
export type InsertStory = z.infer<typeof insertStorySchema>;
