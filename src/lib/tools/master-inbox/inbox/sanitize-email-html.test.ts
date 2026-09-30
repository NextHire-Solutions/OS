import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanStyle, safeUrl, sanitizeEmailHtml } from "./sanitize-email-html.ts";

test("script-bearing URLs are refused, disguised or not", () => {
  for (const u of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "vbscript:x", "data:text/html,<script>x</script>"]) {
    assert.equal(safeUrl(u, "href"), null, u);
    assert.equal(safeUrl(u, "src"), null, u);
  }
});

test("ordinary links and images survive", () => {
  assert.equal(safeUrl("https://kw.com/agent", "href"), "https://kw.com/agent");
  assert.equal(safeUrl("mailto:jane@kw.com", "href"), "mailto:jane@kw.com");
  assert.equal(safeUrl("tel:+15551234", "href"), "tel:+15551234");
  assert.equal(safeUrl("#top", "href"), "#top");
  assert.equal(safeUrl("cid:logo123", "src"), "cid:logo123");
  assert.equal(safeUrl("data:image/png;base64,AAAA", "src"), "data:image/png;base64,AAAA");
  assert.equal(safeUrl("mailto:x@y.z", "src"), null);
});

test("style keeps layout but loses script, bindings and page-escaping position", () => {
  assert.equal(cleanStyle("color: red; font-size: 12px"), "color: red; font-size: 12px");
  assert.equal(cleanStyle("width: expression(alert(1)); color: red"), " color: red");
  assert.equal(cleanStyle("position: fixed; top: 0"), " top: 0");
  assert.equal(cleanStyle("background: url(javascript:alert(1))"), "");
  assert.equal(cleanStyle("background: url('https://x.com/a.png')"), "background: url('https://x.com/a.png')");
});

test("without a browser DOM the body comes back as escaped text", () => {
  const out = sanitizeEmailHtml('<p>Hi <img src=x onerror="alert(1)"> there</p><script>alert(2)</script>');
  assert.ok(!/[<>]/.test(out), out);
  assert.match(out, /Hi/);
});
