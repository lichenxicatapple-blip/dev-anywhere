import { test } from "@playwright/test";
import {
  verifyHiddenCursorRedraw,
  verifyManualHorizontalReview,
} from "../pty-cursor-redraw-helpers";

test.use({ viewport: { width: 360, height: 704 }, hasTouch: true });

test("does not pan to a hidden paint cursor between a redraw and cursor restoration", async ({
  page,
}, testInfo) => {
  await verifyHiddenCursorRedraw(page, testInfo);
});

test("keeps a partial horizontal pan until the user resumes input", async ({ page }, testInfo) => {
  await verifyManualHorizontalReview(page, testInfo);
});
