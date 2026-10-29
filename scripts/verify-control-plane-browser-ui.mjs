import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function verifyPersonalSurface(page, label, name, backLabel) {
  const artifacts = process.env.BB_CONTROL_PLANE_BROWSER_ARTIFACTS;
  const viewport = page.viewportSize();
  const previous = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    fontSize: document.documentElement.style.fontSize,
  }));
  const region = page.getByRole("region", { name: label, exact: true });
  async function capture(variant) {
    await region.evaluate((element) => element.scrollTo(0, 0));
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      true,
      `${name} ${variant}: page overflows`,
    );
    assert.equal(
      await region.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
      true,
      `${name} ${variant}: content overflows`,
    );
    if (artifacts) {
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      await page.screenshot({
        path: join(artifacts, `${name}-${variant}.png`),
        animations: "disabled",
      });
    }
  }
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    await capture("desktop");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await capture("dark");
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    await page.setViewportSize({ width: 375, height: 812 });
    if (backLabel)
      assert.equal(
        await page
          .getByRole("button", { name: backLabel, exact: true })
          .isVisible(),
        true,
      );
    await capture("mobile");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
    });
    await capture("mobile-large-text");
    await page.evaluate((fontSize) => {
      document.documentElement.style.fontSize = fontSize;
    }, previous.fontSize);
    await page.setViewportSize({ width: 812, height: 375 });
    await capture("landscape");
  } finally {
    await page.evaluate((state) => {
      document.documentElement.classList.toggle("dark", state.dark);
      document.documentElement.style.fontSize = state.fontSize;
    }, previous);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (viewport) await page.setViewportSize(viewport);
  }
}
