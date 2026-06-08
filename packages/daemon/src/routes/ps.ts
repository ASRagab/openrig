import { Hono } from "hono";
import type { PsProjectionService } from "../domain/ps-projection.js";

export const psRoutes = new Hono();

psRoutes.get("/", (c) => {
  const psService = c.get("psProjectionService" as never) as PsProjectionService;
  // OPR.0.3.3.19 - default excludes archived; ?includeArchived=true / ?archived=only opt in.
  const includeArchived = c.req.query("includeArchived") === "true";
  const archivedOnly = c.req.query("archived") === "only";
  return c.json(psService.getEntries({ includeArchived, archivedOnly }));
});
