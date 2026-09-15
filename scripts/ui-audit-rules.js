/*
 * The rules, as page-side code.
 *
 * A SEPARATE FILE on purpose. The previous auditor kept these in a JS template
 * literal inside the driver, which meant every backslash had to be written
 * twice and every regex was one edit away from silently meaning something
 * else. Read raw and injected as-is, what is written here is what runs.
 *
 * Defines window.__audit(), returning { faults: [...] }.
 */
window.__audit = function () {
  const vw = innerWidth;
  const faults = [];
  const add = (kind, el, detail) => {
    if (faults.length >= 60) return;
    faults.push({ kind, el: name(el), text: txt(el), detail });
  };

  function name(e) {
    if (!e || !e.tagName) return "?";
    const cls =
      e.className && typeof e.className === "string"
        ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    return e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + cls;
  }
  /*
   * Scroll-clipped means invisible.
   *
   * getBoundingClientRect() reports LAYOUT position, not what is painted: an
   * item 60px below the fold of a scrolling rail still reports a rect, and that
   * rect "overlaps" whatever sits under the rail's footer. Every OVERLAP the
   * first run found was the Admin item of a scrolled rail, reported as sitting
   * on the sign-out button. An element that any overflow:auto/scroll/hidden
   * ancestor has clipped away is not on screen and cannot overlap anything.
   */
  function scrollClipped(e) {
    const r = e.getBoundingClientRect();
    for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
      const c = getComputedStyle(n);
      const clips = (v) => v === "auto" || v === "scroll" || v === "hidden";
      if (!clips(c.overflowY) && !clips(c.overflowX)) continue;
      const p = n.getBoundingClientRect();
      if (r.bottom <= p.top + 1 || r.top >= p.bottom - 1 || r.right <= p.left + 1 || r.left >= p.right - 1) return true;
    }
    return false;
  }
  function inHorizontalScroller(e) {
    for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  }
  function inFixedChrome(e) {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
      if (n.classList && (n.classList.contains("rail") || n.classList.contains("topbar"))) return true;
    }
    return false;
  }
  function txt(e) {
    return (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34);
  }
  /*
   * Visibility must account for ANCESTORS, not just the element itself.
   *
   * The command palette is closed with `opacity: 0` on its container. Every row
   * inside still reports its OWN computed opacity as 1 — opacity is not
   * inherited as a computed value — so an element-only check called them all
   * visible and reported the invisible palette overlapping the page beneath it.
   * The same shape of mistake as `ownerSVGElement !== null`: a property whose
   * value does not mean what the test assumed it meant.
   *
   * `checkVisibility` walks the tree and answers it properly. The manual check
   * stays as a fallback so a browser without it degrades to the old behaviour
   * rather than silently calling everything invisible, which would make every
   * rule pass.
   */
  function visible(e) {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    if (typeof e.checkVisibility === "function") {
      return e.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      });
    }
    const c = getComputedStyle(e);
    return c.visibility !== "hidden" && c.display !== "none" && c.opacity !== "0";
  }

  /*
   * Is overflow RECOVERABLE? Walk up and ask which comes first.
   *
   * Hitting a scrollable ancestor means the user can scroll to it — fine.
   * Hitting overflow:hidden first means the content is simply gone.
   * Reaching <body> with nothing clipping means it merely extends, which
   * PAGE-OVERFLOW already judges. Immediate-parent-only was too strict (a long
   * word in a <p> inside a scrolling panel is reachable); the whole chain was
   * too loose (the page's own scroller excused everything).
   */
  function recoverable(e) {
    let a = e.parentElement;
    while (a && a !== document.body) {
      const c = getComputedStyle(a);
      const o = c.overflowX + " " + c.overflowY;
      if (/(auto|scroll)/.test(o)) return true;
      if (/(hidden|clip)/.test(o)) return false;
      a = a.parentElement;
    }
    return true;
  }

  /* 1. PAGE-OVERFLOW — the document scrolls sideways. Nothing should. */
  if (document.documentElement.scrollWidth > vw + 1) {
    faults.push({
      kind: "PAGE-OVERFLOW", el: "<html>", text: "",
      detail: document.documentElement.scrollWidth - vw + "px wider than the viewport",
    });
  }

  /*
   * 2. COLLAPSED — has text, zero height.
   *
   * Checked BEFORE any visibility filter, because such a filter requires
   * height > 0 and would exclude exactly what this hunts. That bug made this
   * rule unable to fire at all.
   */
  for (const e of document.querySelectorAll("body *")) {
    if (e.children.length) continue;
    if ((e.textContent || "").trim().length < 3) continue;
    const c = getComputedStyle(e);
    if (c.display === "none" || c.visibility === "hidden") continue;
    const r = e.getBoundingClientRect();
    if (r.height < 1 && r.width > 0) add("COLLAPSED", e, "has text, zero height");
  }

  const shown = [...document.querySelectorAll("body *")].filter(visible);

  for (const e of shown) {
    const r = e.getBoundingClientRect();
    const c = getComputedStyle(e);
    // A leaf carrying real words — what EDGE-FLUSH and BAD-TEXT look at.
    const leafText = e.children.length === 0 && (e.textContent || "").trim().length > 2;

    /*
     * EDGE-FLUSH — text sitting hard against the edge of the screen.
     *
     * "No margins" is how a person describes it. A leaf with real text whose
     * box starts within 6px of the viewport's left edge, or ends within 6px of
     * its right edge, has no gutter at all. The shell's stage and every `.wrap`
     * carry side padding, so this only fires when a screen bypassed both.
     * Fixed/sticky chrome (the rail, top bar) is exempt — those are edges by
     * design.
     */
    /*
     * Not inside a horizontal scroller. A 17-column table wider than the
     * screen scrolls sideways by design, and its right-hand cells sit past the
     * viewport edge until scrolled — 1,249 of the first run's 1,537 findings
     * were exactly that. The left edge still counts: nothing legitimately
     * starts flush against x=0.
     */
    if (leafText && r.width > 20 && !inFixedChrome(e)) {
      const vw = document.documentElement.clientWidth;
      const scrolls = inHorizontalScroller(e);
      if (r.left < 6 || (!scrolls && r.right > vw - 6)) {
        add("EDGE-FLUSH", e, `x ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}px — no gutter`);
      }
    }

    /*
     * BAD-TEXT — a value that was never meant to be shown.
     *
     * `undefined`, `null`, `NaN`, `[object Object]`, `$NaN`, `NaN%`, `Invalid
     * Date`: each one is a formatter that received nothing and printed the
     * nothing. They never trip a layout rule because they lay out perfectly.
     */
    if (leafText) {
      const t = (e.textContent || "").trim();
      if (/^(undefined|null|NaN|\[object Object\]|Invalid Date)$/.test(t) ||
          /(^|[^A-Za-z])(NaN|undefined)([^A-Za-z]|$)/.test(t)) {
        add("BAD-TEXT", e, JSON.stringify(t.slice(0, 40)));
      }
    }

    /*
     * EMPTY-BOX — a card that draws its frame and nothing inside it.
     *
     * A bordered or filled block taller than 40px with no text, no image, no
     * svg and no form control is a box the reader sees and cannot use. Usually
     * a loader that never resolved or a section whose data was null and whose
     * empty state was never written.
     */
    if (r.height > 40 && r.width > 80 && !inFixedChrome(e)) {
      const framed = (c.borderTopWidth !== "0px" && c.borderTopStyle !== "none") ||
        (c.backgroundColor !== "rgba(0, 0, 0, 0)" && c.backgroundColor !== "transparent");
      const tag = e.tagName.toLowerCase();
      // A control is its own content; a cell or row is framed by its table, and an
      // empty <th> over a checkbox column is the design, not a fault.
      // <i> is decorative in this design system: bar fills (.bar-h i), toggle
      // knobs (.tg i). Its parent's class says so when its own does not.
      const parentCls = (e.parentElement && e.parentElement.className) || "";
      const isControlOrCell = /^(input|select|textarea|button|img|svg|canvas|video|iframe|th|td|tr|hr|i)$/.test(tag) ||
        e.getAttribute("role") === "checkbox" ||
        /bar|track|meter|progress|toggle|\btg\b|spark/i.test(String(parentCls));
      const hasContent = isControlOrCell || (e.textContent || "").trim().length > 0 ||
        e.querySelector("img, svg, canvas, video, input, select, textarea, button, [role=progressbar]");
      // Things that are legitimately a framed box with nothing "in" it: an
      // avatar or logo drawn as a background image, a colour swatch, a
      // checkbox span, a chart track. Text-less by design, not by failure.
      const isSkeletonOrBar = /skel|bar|track|spark|chart|progress|divider|sep|dot|stripe|overlay|backdrop|av\b|avatar|logo|icon|glyph|swatch|thumb|cbx|check|toggle|\btg\b|tile|badge-dot|pill-dot/i.test(e.className || "") ||
        (c.backgroundImage && c.backgroundImage !== "none") ||
        e.getAttribute("aria-hidden") === "true" || e.hasAttribute("aria-busy");
      if (framed && !hasContent && !isSkeletonOrBar && e.children.length === 0) {
        add("EMPTY-BOX", e, `${Math.round(r.width)}x${Math.round(r.height)}px framed, no content`);
      }
    }

    /*
     * 3. CLIPPED-TEXT — cut off with no ellipsis to admit it.
     *
     * SVG is exempt: clientWidth is an HTML box-model property and reports
     * nonsense for <text>, which paints with overflow visible and is never
     * clipped by its own box. A chart axis label measured 77 > 72 and was
     * reported as cut off while being entirely on screen.
     */
    /*
     * `Boolean(...)`, NOT `!== null`.
     *
     * `ownerSVGElement` is UNDEFINED on an HTML element, not null. The original
     * check read `e.ownerSVGElement !== null`, which is true for undefined —
     * so every HTML element on every page took the SVG exemption and this rule
     * could never fire at all. Same shape as `offsetParent` being null for
     * position:fixed: a property whose "absent" value is not the one the test
     * assumed, turning a rule into a no-op that looks like a pass.
     */
    const inSvg = Boolean(e.ownerSVGElement) || e.tagName.toLowerCase() === "svg";
    const leaf = !inSvg && e.children.length === 0 && (e.textContent || "").trim().length > 2;
    if (
      leaf &&
      e.scrollWidth > e.clientWidth + 1 &&
      c.textOverflow !== "ellipsis" &&
      !/(auto|scroll)/.test(c.overflowX) &&
      c.whiteSpace !== "pre"
    ) {
      add("CLIPPED-TEXT", e, e.scrollWidth + ">" + e.clientWidth + "px, no ellipsis");
    }

    /*
     * 4. ESCAPES-PARENT — sticking out of something that clips it.
     *
     * Absolutely positioned elements are excluded: being placed outside the
     * parent's flow is what they are FOR, and a popover deliberately offset
     * from its anchor is not a fault. Popovers are measured by
     * popover-clip-test.mjs, which knows what they are.
     */
    if (c.position !== "fixed" && c.position !== "absolute") {
      const p = e.parentElement;
      if (p && p !== document.body && !recoverable(e)) {
        const pr = p.getBoundingClientRect();
        /*
         * A parent collapsed to nothing is a CLOSED DISCLOSURE, not lost
         * content — the same category as display:none.
         *
         * The sidebar accordion is exactly this: `.acc-inner` is
         * `overflow:hidden` with an animated height, so every closed section
         * holds a full-height `.acc-list` inside a 0px box. Without this, the
         * four closed sections were reported on all 33 screens at all 3
         * widths — 354 of 357 findings, every one of them the navigation
         * working correctly. A rule that cries wolf 354 times is a rule
         * nobody reads.
         */
        const collapsed = pr.height < 2 || pr.width < 2;
        /*
         * An inline run inside a nowrap + overflow:hidden + text-overflow:
         * ellipsis box is a TRUNCATION, not an escape: the browser draws the
         * ellipsis on the parent's line box and the child's overrun is exactly
         * the part it replaced. `/analytics/copy` reported 37 of these — a
         * campaign name in a <span> inside the "from" label — every one of
         * them rendering as a tidy "Douglas Elliman NYC + Nic…".
         */
        const pc = getComputedStyle(p);
        const truncated = c.display.startsWith("inline") && pc.whiteSpace === "nowrap" &&
          pc.textOverflow === "ellipsis" && /(hidden|clip)/.test(pc.overflowX);
        const over = Math.round(Math.max(r.right - pr.right, pr.left - r.left, r.bottom - pr.bottom));
        if (!collapsed && !truncated && over > 2 && pr.width > 0) add("ESCAPES-PARENT", e, over + "px past " + name(p));
      }
    }
  }

  /*
   * 5. OVERLAP — two controls physically cover each other, so one cannot be
   * clicked.
   *
   * This rule was DESCRIBED in the previous auditor and never written, so it
   * reported nothing for as long as it existed.
   *
   * Only interactive elements, because overlapping decoration is usually
   * deliberate (a badge on an avatar). Nesting is excluded — a <label> around
   * an <input> overlaps by design. So is anything with pointer-events:none,
   * and anything inside an open popover, which is SUPPOSED to sit over the
   * page.
   */
  const SEL = "button, a[href], input, select, textarea, [role=button], [role=tab]";
  const controls = [...document.querySelectorAll(SEL)].filter((e) => {
    if (!visible(e)) return false;
    const c = getComputedStyle(e);
    if (c.pointerEvents === "none") return false;
    if (e.closest("[data-anchored-panel]")) return false;
    /*
     * A rendered EMAIL BODY is somebody else's HTML.
     *
     * `.msg-body` holds the message exactly as the sender wrote it. This
     * flagged two overlapping `mailto:` links in a sender's signature — real
     * overlap, in markup nobody here can change. Judging a third party's email
     * layout as a fault in this product means the rule reports something
     * unfixable on every conversation, and a rule that always complains is a
     * rule people stop reading.
     */
    if (e.closest(".msg-body")) return false;
    const r = e.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  });

  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();

      /*
       * An absolutely-positioned control sitting ENTIRELY INSIDE another is
       * the icon-in-a-field pattern, not a collision — the "Show key" eye at
       * the end of the API-key input is exactly this, and clicking there is
       * meant to hit the eye. Both controls remain reachable, because one
       * deliberately owns a corner of the other.
       *
       * A genuine collision is a PARTIAL overlap: two controls that each
       * expect the same space, where one is unreachable. So containment is
       * excluded and partial overlap is not.
       */
      const inside = (x, y) =>
        x.left >= y.left - 1 && x.right <= y.right + 1 &&
        x.top >= y.top - 1 && x.bottom <= y.bottom + 1;
      const ca = getComputedStyle(a), cb2 = getComputedStyle(b);
      if (ca.position === "absolute" && inside(ra, rb)) continue;
      if (cb2.position === "absolute" && inside(rb, ra)) continue;

      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      // 4px in BOTH axes: a 1px shared border or a rounding artefact is not an
      // overlap, and adjacent controls touching edge-to-edge are normal.
      if (ox > 4 && oy > 4) {
        if (!scrollClipped(a) && !scrollClipped(b)) add("OVERLAP", a, Math.round(ox) + "x" + Math.round(oy) + "px over " + name(b));
      }
    }
  }

  /*
   * 6. NO-ACCESSIBLE-NAME — a control nobody can name.
   *
   * Icon-only buttons are the whole risk here: they look fine and are
   * unusable with a screen reader, and untestable by name. This is the small
   * detail that is invisible until someone needs it.
   *
   * A control counts as named by its own text, aria-label, aria-labelledby,
   * title, an <svg><title>, or — for inputs — an associated <label> or
   * placeholder. Anything still unnamed has genuinely nothing.
   */
  for (const e of controls) {
    const tag = e.tagName.toLowerCase();
    if (tag === "input" && ["hidden", "submit", "reset"].includes(e.type)) continue;
    const own = (e.textContent || "").trim();
    if (own.length > 0) continue;
    if (e.getAttribute("aria-label")?.trim()) continue;
    if (e.getAttribute("aria-labelledby")) continue;
    if (e.getAttribute("title")?.trim()) continue;
    if (e.querySelector("svg title, svg desc")) continue;
    if (e.getAttribute("alt")?.trim()) continue;
    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (e.placeholder?.trim()) continue;
      if (e.labels && e.labels.length > 0) continue;
      if (e.closest("label")) continue;
    }
    add("NO-NAME", e, tag + " has no text, label, title or aria-label");
  }

  /*
   * 7. TINY-TARGET — a control too small to hit reliably.
   *
   * 16px is deliberately well under the 24px accessibility guideline: the aim
   * is to catch controls that are actually broken (a collapsed icon button, a
   * zero-padding link), not to argue with the design about a compact 20px
   * close button.
   */
  for (const e of controls) {
    /*
     * Native checkboxes and radios render at the platform's own 13x13 and are
     * not ours to resize — flagging them is an argument with the browser, not
     * a finding. Every one in this workspace carries an aria-label, which the
     * NO-NAME rule checks separately.
     */
    const type = (e.getAttribute("type") || "").toLowerCase();
    if (e.tagName.toLowerCase() === "input" && (type === "checkbox" || type === "radio")) continue;

    /*
     * An inline link sized by its own text is not a "target" in this sense —
     * its height is just the line box of a 12px font, and the words are the
     * thing you click. `a[href="mailto:…"]` around an address is the shape
     * this protects. Icon-only controls stay in scope, which is the point:
     * they have no text to aim at.
     */
    const c2 = getComputedStyle(e);
    const label = (e.textContent || "").trim();
    if (c2.display === "inline" && label.length > 2) continue;

    const r = e.getBoundingClientRect();
    if (r.width < 16 || r.height < 16) {
      add("TINY-TARGET", e, Math.round(r.width) + "x" + Math.round(r.height) + "px");
    }
  }

  /*
   * 8. INVISIBLE-TEXT — text the same colour as what is behind it.
   *
   * The real background has to be resolved by walking up: an element is
   * usually transparent and inherits whatever ancestor last painted. Comparing
   * against the element's own `background-color` would compare against
   * "rgba(0, 0, 0, 0)" every time and never fire.
   */
  function paintedBackground(e) {
    let a = e;
    while (a && a !== document.documentElement) {
      const bg = getComputedStyle(a).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(bg)) return bg;
      a = a.parentElement;
    }
    return "rgb(255, 255, 255)";
  }
  const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  for (const e of shown) {
    if (e.children.length) continue;
    const t = (e.textContent || "").trim();
    if (t.length < 2) continue;
    const c = getComputedStyle(e);
    if (parseFloat(c.opacity) === 0) continue;
    const fg = rgb(c.color), bg = rgb(paintedBackground(e));
    if (fg.length < 3 || bg.length < 3) continue;
    const dist = Math.abs(fg[0] - bg[0]) + Math.abs(fg[1] - bg[1]) + Math.abs(fg[2] - bg[2]);
    if (dist < 12) add("INVISIBLE-TEXT", e, "text " + c.color + " on " + paintedBackground(e));
  }

  /*
   * 9. BROKEN-IMAGE — an <img> that failed to load.
   *
   * `naturalWidth === 0` on a complete image is the only reliable signal; a
   * broken image otherwise renders as empty space that looks like a layout
   * choice.
   */
  for (const img of document.querySelectorAll("img")) {
    if (!img.complete) continue;
    if (img.naturalWidth === 0) add("BROKEN-IMAGE", img, "src=" + (img.getAttribute("src") || "").slice(0, 60));
  }

  return { vw, vh: innerHeight, faults };
};
