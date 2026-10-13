"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { AnchoredPanel } from "@/components/ui/anchored-panel";
import { fullNumber } from "@/lib/tools/analytics/format.ts";
import {
  LOCATION_FIELDS,
  MAX_CITIES_PER_FIELD,
  NO_LOCATION,
  isChosen,
  locationActive,
  locationLabel,
  narrowCities,
  orderCities,
  readLocations,
  toggleCity,
  type LocationKey,
  type LocationSelection,
} from "@/lib/tools/analytics/campaigns/location-filter.ts";

import { CAMPAIGN_LEAD_LOCATIONS_URL, useAnalyticsData } from "./actions";
import { Btn } from "./toast";

/*
 * "Location" on a campaign's Leads tab (13 Oct) — office city, home city,
 * most transacted city.
 *
 * A chip beside the status chips and Sales volume, because it is the same
 * kind of thing: a filter on the table. The cities are applied in SQL
 * (analytics 097), so the filter holds across every page, the total, and
 * "Select all matching" — which is the point: pick a city, select everyone in
 * it, remove them from the campaign.
 *
 * CITIES ARE PICKED, NOT TYPED. The list is this campaign's own cities with
 * how many leads each has, so there is nothing to misspell and a city with no
 * leads cannot be chosen. (Typing a city into the search box works too — that
 * matches office city since 097 — but it is a "contains", and it is one city
 * at a time.)
 */
export function LocationFilter({
  campaignId,
  value,
  onChange,
}: {
  campaignId: string;
  value: LocationSelection;
  onChange: (next: LocationSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const active = locationActive(value);

  return (
    <span style={{ position: "relative" }}>
      <button
        ref={trigger}
        type="button"
        className={`schip${active ? "" : " off"}`}
        aria-pressed={active}
        aria-expanded={open}
        data-location-filter
        title="Filter by office city, home city or most transacted city"
        onClick={() => setOpen((v) => !v)}
        // One long city must not push the rest of the toolbar onto a new line.
        style={{ maxWidth: 260 }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{locationLabel(value)}</span>{" "}
        <span aria-hidden="true" style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>
      {/* 404 wide: the three field names on one line (the longest is "Most
          transacted city"); narrower and the third wrapped under the first. */}
      <AnchoredPanel anchorRef={trigger} open={open} onClose={close} width={404} align="start" label="Filter by location">
        {/*
          Mounted only while open, so every opening starts from what is
          APPLIED: ticks made and then abandoned (Escape, a click outside) are
          not still sitting there next time, looking as if they were in force.
        */}
        {open ? (
          <LocationPanel
            campaignId={campaignId}
            applied={value}
            onApply={(next) => {
              onChange(next);
              setOpen(false);
            }}
          />
        ) : null}
      </AnchoredPanel>
    </span>
  );
}

function LocationPanel({
  campaignId,
  applied,
  onApply,
}: {
  campaignId: string;
  applied: LocationSelection;
  onApply: (next: LocationSelection) => void;
}) {
  const [draft, setDraft] = useState<LocationSelection>(applied);
  // Open on the field that already has cities chosen, else the first.
  const [field, setField] = useState<LocationKey>(
    () => LOCATION_FIELDS.find((f) => applied[f.key].length > 0)?.key ?? LOCATION_FIELDS[0].key,
  );
  const [typed, setTyped] = useState("");

  const { data, loading, error } = useAnalyticsData<{ locations: unknown }>(CAMPAIGN_LEAD_LOCATIONS_URL(campaignId));
  const options = useMemo(() => readLocations(data?.locations), [data]);

  const def = LOCATION_FIELDS.find((f) => f.key === field)!;
  const chosen = draft[field];
  /*
   * Ordered by what was applied when the panel opened, not by the ticks being
   * made now: a row that jumped to the top the moment it was ticked would move
   * the next row under the cursor.
   */
  const ordered = useMemo(() => orderCities(options[field], applied[field]), [options, field, applied]);
  const shown = useMemo(() => narrowCities(ordered, typed), [ordered, typed]);
  const full = chosen.length >= MAX_CITIES_PER_FIELD;

  const pick = (key: LocationKey) => {
    setField(key);
    setTyped("");
  };

  return (
    <form
      data-location-panel
      style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
      onSubmit={(e) => {
        e.preventDefault();
        onApply(draft);
      }}
    >
      <div style={{ padding: "14px 14px 10px", display: "grid", gap: 10 }}>
        <div className="grp-h" style={{ padding: 0 }}>Location</div>
        <div role="tablist" aria-label="Which city" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {LOCATION_FIELDS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={field === f.key}
              data-location-field={f.key}
              className={`schip${field === f.key ? "" : " off"}`}
              onClick={() => pick(f.key)}
            >
              {f.label}
              {draft[f.key].length ? <span className="tnum" style={{ fontWeight: 600 }}>{draft[f.key].length}</span> : null}
            </button>
          ))}
        </div>
        {options[field].length > 8 ? (
          <input
            id="location-filter-find"
            className="inp"
            type="search"
            placeholder="Find a city…"
            aria-label={`Find a city in ${def.label}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            style={{ width: "100%", minWidth: 0 }}
            autoFocus
          />
        ) : null}
      </div>

      <div
        data-location-list
        style={{ overflowY: "auto", flex: 1, minHeight: 90, maxHeight: 264, padding: "0 14px", borderTop: "1px solid var(--line-soft)", borderBottom: "1px solid var(--line-soft)" }}
      >
        {error ? (
          <div role="alert" className="mut" style={{ padding: "18px 0", fontSize: 12.5, lineHeight: 1.5 }}>{error}</div>
        ) : !data && loading ? (
          <div className="mut" style={{ padding: "18px 0", fontSize: 12.5 }}>Loading cities…</div>
        ) : ordered.length === 0 ? (
          <div className="mut" data-location-empty style={{ padding: "18px 0", fontSize: 12.5, lineHeight: 1.5 }}>
            No lead in this campaign has {def.label === "Office city" ? "an" : "a"} {def.label.toLowerCase()} on file, so there is nothing to choose here.
          </div>
        ) : shown.length === 0 ? (
          <div className="mut" style={{ padding: "18px 0", fontSize: 12.5 }}>No city matches “{typed.trim()}”.</div>
        ) : (
          shown.map((o) => {
            const on = isChosen(chosen, o.value);
            return (
              <label
                key={o.value.toLowerCase()}
                data-location-option
                style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 13, cursor: !on && full ? "not-allowed" : "pointer", opacity: !on && full ? 0.5 : 1 }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && full}
                  style={{ accentColor: "var(--blue)", cursor: "inherit" }}
                  onChange={() => setDraft((d) => ({ ...d, [field]: toggleCity(d[field], o.value) }))}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.value}>{o.value}</span>
                <span className="tnum mut" style={{ fontSize: 12 }}>{fullNumber(o.leads)}</span>
              </label>
            );
          })
        )}
      </div>

      <div style={{ padding: "10px 14px 14px", display: "grid", gap: 10 }}>
        <div className="mut" style={{ fontSize: 12, lineHeight: 1.45 }}>
          {full
            ? `That is the most for one field (${MAX_CITIES_PER_FIELD} cities).`
            : "Tick more than one city to see leads in any of them. A lead has to match every field you tick cities in."}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <Btn disabled={!locationActive(applied) && !locationActive(draft)} onClick={() => onApply(NO_LOCATION)}>
            Clear
          </Btn>
          <Btn primary type="submit">
            Apply
          </Btn>
        </div>
      </div>
    </form>
  );
}
