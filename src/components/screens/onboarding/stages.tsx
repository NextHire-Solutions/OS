"use client";

import { useState } from "react";

import type { StagesBoard } from "@/lib/tools/onboarding/stages";
import { STAGE_COLORS, toneOf } from "@/lib/tools/onboarding/stage-types";
import { PlaceholderScreen } from "../lazy";
import {
  STAGES_URL,
  createStage,
  moveStage,
  recolourStage,
  removeStage,
  renameStage,
  useOnboardingData,
} from "./actions";
import { Btn, ConfirmButton, Toast, useToast } from "./toast";

/*
 * Onboarding — the stage board.
 *
 * A port of the orchestrator's `/stages` page (app/stages/page.tsx +
 * components/StageEditor.tsx), rebuilt in the workspace's own classes.
 *
 * These are the team's stages, and the whole point is that they own them: add,
 * rename, recolour, reorder, delete. Nothing in the automation reads a stage to
 * decide whether to do work — moving a client between them is a label change, and
 * the `orch_clients.status` column the automation actually uses is untouched.
 *
 * Every control on this screen writes to `orch_stages` in the orchestrator's own
 * database, so a change made here is the change the live tool sees.
 */

export function OnboardingStagesScreen({ initial }: { initial: StagesBoard | null }) {
  const { data, error, reload } = useOnboardingData<StagesBoard>(initial, STAGES_URL);

  if (error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Stages could not be loaded.</b> {error}
        </div>
      </div>
    );
  }
  if (!data) return <PlaceholderScreen cards={3} />;
  return <StagesView board={data} reload={reload} />;
}

function StagesView({ board, reload }: { board: StagesBoard; reload: () => Promise<void> }) {
  const { toast, show } = useToast();
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const { stages, counts, unplaced } = board;
  const placed = Object.values(counts).reduce((a, b) => a + b, 0);

  /*
   * One wrapper for every write: block the screen, run it, say what happened,
   * then re-read. Re-reading rather than patching local state is why the row
   * counts and the order can never drift from the database.
   */
  async function run(what: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      const result = (await fn()) as { moved?: number } | undefined;
      await reload();
      const moved = result?.moved ?? 0;
      show({
        text:
          moved > 0
            ? `${what}. ${moved} client${moved === 1 ? "" : "s"} moved to the first stage.`
            : what,
      });
    } catch (e) {
      show({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (board.error) {
    return (
      <div className="wrap">
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>Onboarding could not be read.</b> {board.error}. The orchestrator itself is
          unaffected — this is the workspace&rsquo;s connection to its database.
        </div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="card">
          <div className="card-l">Stages</div>
          <div className="card-n tnum">{stages.length}</div>
          <div className="card-s">on the board</div>
        </div>
        <div className="card">
          <div className="card-l">Clients placed</div>
          <div className="card-n tnum">{placed}</div>
          <div className="card-s">standing on a stage</div>
        </div>
        <div className="card">
          <div className="card-l">Unplaced</div>
          <div className={`card-n tnum${unplaced > 0 ? " n-risk" : " n-green"}`}>{unplaced}</div>
          <div className="card-s">on no stage at all</div>
        </div>
      </div>

      {unplaced > 0 && (
        <div className="anno" style={{ margin: "0 0 18px" }}>
          <b>
            {unplaced} client{unplaced === 1 ? "" : "s"} on no stage.
          </b>{" "}
          They appear on the first stage on the pipeline, but nothing has actually placed them —
          which is how a client gets forgotten.
        </div>
      )}

      <div className="tbl-wrap">
        <div className="tbl-head">
          <div>
            <div className="tbl-title">Pipeline stages</div>
            <div className="tbl-sub">
              Top to bottom is the order they appear on the pipeline. Deleting a stage never
              deletes clients — anyone standing on it moves to the first stage.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              className="inp"
              placeholder="Stage name, e.g. Contract signed"
              value={newName}
              disabled={busy}
              aria-label="New stage name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) {
                  const name = newName.trim();
                  setNewName("");
                  void run(`Added “${name}”`, () => createStage(name));
                }
              }}
            />
            <Btn
              primary
              disabled={busy || !newName.trim()}
              onClick={() => {
                const name = newName.trim();
                setNewName("");
                void run(`Added “${name}”`, () => createStage(name));
              }}
            >
              Add stage
            </Btn>
          </div>
        </div>

        <div className="tbl-scroll">
          <table style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ width: 108 }}>Order</th>
                <th>Name</th>
                <th style={{ width: 210 }}>Colour</th>
                <th style={{ width: 110 }}>Clients</th>
                <th style={{ width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {stages.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: "34px 16px", textAlign: "center", color: "var(--muted)" }}>
                    No stages yet. Add the first one above.
                  </td>
                </tr>
              ) : (
                stages.map((s, i) => {
                  const n = counts[s.id] ?? 0;
                  const tone = toneOf(s.color);
                  return (
                    <tr key={s.id}>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <Btn
                            disabled={busy || i === 0}
                            title="Move up"
                            aria-label={`Move ${s.name} up`}
                            style={{ padding: "6px 10px" }}
                            onClick={() => void run(`Moved “${s.name}” up`, () => moveStage(s.id, "up"))}
                          >
                            ↑
                          </Btn>
                          <Btn
                            disabled={busy || i === stages.length - 1}
                            title="Move down"
                            aria-label={`Move ${s.name} down`}
                            style={{ padding: "6px 10px" }}
                            onClick={() => void run(`Moved “${s.name}” down`, () => moveStage(s.id, "down"))}
                          >
                            ↓
                          </Btn>
                        </div>
                      </td>

                      <td>
                        {/*
                          Uncontrolled with a key, committed on blur — the tool's
                          own behaviour. `key` carries the stored name so that a
                          reorder or a failed save re-mounts the input with the
                          value the database actually holds, rather than leaving
                          a stale edit on screen.
                        */}
                        <input
                          className="inp"
                          key={`${s.id}:${s.name}`}
                          defaultValue={s.name}
                          disabled={busy}
                          aria-label={`Rename ${s.name}`}
                          style={{ minWidth: 180, width: "100%", maxWidth: 340 }}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (!next || next === s.name) return;
                            void run(`Renamed to “${next}”`, () => renameStage(s.id, next));
                          }}
                        />
                      </td>

                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          {/* The swatch is the point of the column — the dropdown
                              alone told them nothing. */}
                          <span
                            aria-hidden="true"
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 7,
                              background: tone.bg,
                              border: `1px solid ${tone.fg}`,
                              flex: "none",
                            }}
                          />
                          <select
                            className="inp"
                            value={s.color ?? "neutral"}
                            disabled={busy}
                            aria-label={`Colour for ${s.name}`}
                            style={{ cursor: "pointer", minWidth: 120 }}
                            onChange={(e) =>
                              void run(`“${s.name}” is now ${e.target.value}`, () =>
                                recolourStage(s.id, e.target.value),
                              )
                            }
                          >
                            {STAGE_COLORS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>

                      <td>
                        {n > 0 ? (
                          <span
                            className="tg"
                            style={{ background: tone.bg, borderColor: "transparent", color: tone.fg }}
                          >
                            {n}
                          </span>
                        ) : (
                          <span className="api-none">none</span>
                        )}
                      </td>

                      <td>
                        <ConfirmButton
                          label="Delete"
                          armedLabel="Confirm delete"
                          title={
                            n > 0
                              ? `Delete “${s.name}”? ${n} client${n === 1 ? "" : "s"} will move to the first stage.`
                              : `Delete “${s.name}”?`
                          }
                          disabled={busy || stages.length <= 1}
                          onConfirm={() => void run(`Deleted “${s.name}”`, () => removeStage(s.id))}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Toast toast={toast} />
    </div>
  );
}
