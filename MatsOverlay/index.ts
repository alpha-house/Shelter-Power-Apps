import { IInputs, IOutputs } from "./generated/ManifestTypes";

type Guid = string;

interface MatRow {
  id: string;
  cp_matlabel?: string | null;
  cp_matnumber?: number | null;
  cp_matwidth?: number | null;
  cp_matheight?: number | null;
  cp_xposition?: number | null;
  cp_yposition?: number | null;
  cp_fillcolor?: string | null;
  cp_strokecolor?: string | null;
  // Whether this mat already has a check-in assigned — drives click behaviour
  hasCheckin: boolean;
  // Resolved id of the linked cp_sheltercheckin record, lower-cased, no braces
  checkinId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LookupResult {
  entityType: string;
  id: string; // "{GUID}" format from Xrm
  name: string;
}
interface LookupFilter {
  entityLogicalName: string;
  filterXml: string;
}
interface LookupOptions {
  allowMultiSelect?: boolean;
  entityTypes: string[];
  defaultEntityType?: string;
  defaultViewId?: string;
  viewIds?: string[];
  searchText?: string;
  filters?: LookupFilter[];
}
interface XrmUtilityLike {
  lookupObjects(opts: LookupOptions): Promise<LookupResult[]>;
}
interface XrmLike {
  Utility: XrmUtilityLike;
}
interface AlertDialogStrings { text: string; title?: string; confirmButtonLabel?: string; }
interface AlertDialogOptions { height?: number; width?: number; }

export class MatsOverlay implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private container!: HTMLDivElement;
  private context!: ComponentFramework.Context<IInputs>;
  private notifyOutputChanged!: () => void;

  // Output state
  private selectedId = "";
  private changeKind = "";
  private newX = 0;
  private newY = 0;
  private newW = 0;
  private newH = 0;

  // Drag state
  private dragging = false;
  private dragMatId = "";
  private dragOffsetX = 0;
  private dragOffsetY = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private currentMats: MatRow[] = [];
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  // ── Breathing round status cache — keyed by lower-cased cp_sheltercheckin id ─
  private breathingRoundById = new Map<string, boolean>();
  private breathingRoundFetchInFlight = false;
  private breathingRoundLastFetch = 0;

  // ── Navigation property names — confirmed from $metadata NavProp query ──────
  //   cp_ShelterCheckin  → confirmed by $metadata NavProp query on cp_mat
  //   cp_Client          → confirmed by working processAssessmentAndCreateAdmission JS
  private static readonly NAV_CHECKIN = "cp_ShelterCheckin";
  private static readonly NAV_CLIENT  = "cp_Client";
  private static readonly SET_CHECKIN = "cp_sheltercheckins";
  private static readonly SET_CONTACT = "contacts";

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this.context = context;
    this.notifyOutputChanged = notifyOutputChanged;
    this.container = container;
    this.container.style.width = "100%";
    this.container.style.height = "100%";
    this.container.style.overflow = "auto";
    this.container.style.position = "relative";
    this.container.innerHTML = "";
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.context = context;

    const ds = context.parameters.cp_mat;
    if (!ds || ds.loading) {
      this.renderStatus(ds?.loading ? "⏳ Loading mats..." : "❌ Dataset not bound.");
      return;
    }

    this.scale      = (context.parameters.Scale?.raw   as number)  || 1;
    this.offsetX    = (context.parameters.OffsetX?.raw as number)  || 0;
    this.offsetY    = (context.parameters.OffsetY?.raw as number)  || 0;
    const baseW     = (context.parameters.BaseW?.raw   as number)  || 1200;
    const baseH     = (context.parameters.BaseH?.raw   as number)  || 800;
    const isLayoutMode = (context.parameters.IsLayoutMode?.raw as boolean) || false;

    const mats = this.readMatsFromDataset(ds);
    this.currentMats = mats;
    const overlaps = this.findOverlaps(mats);

    this.refreshBreathingRoundIndicators().catch((err: unknown) => {
      console.error("[MatsOverlay] refreshBreathingRoundIndicators error:", err);
    });

    this.container.innerHTML = "";

    const doc   = this.container.ownerDocument!;
    const svgNS = "http://www.w3.org/2000/svg";

    const wrapper = doc.createElement("div");
    wrapper.style.display       = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.width         = "100%";
    wrapper.style.height        = "100%";

    // ── SVG canvas ────────────────────────────────────────────────────────────
    const svg     = doc.createElementNS(svgNS, "svg");
    const canvasW = baseW * this.scale;
    const canvasH = baseH * this.scale;
    svg.setAttribute("width",   String(canvasW));
    svg.setAttribute("height",  String(canvasH));
    svg.setAttribute("viewBox", `0 0 ${canvasW} ${canvasH}`);
    (svg as unknown as HTMLElement).style.display    = "block";
    (svg as unknown as HTMLElement).style.background = "#f0ede8";
    (svg as unknown as HTMLElement).style.border     = "2px solid #333";
    (svg as unknown as HTMLElement).style.cursor     = "default";
    (svg as unknown as HTMLElement).style.flexShrink = "0";

    // ── Grid ──────────────────────────────────────────────────────────────────
    const defs     = doc.createElementNS(svgNS, "defs");
    const gridSize = 20 * this.scale;
    const pattern  = doc.createElementNS(svgNS, "pattern");
    pattern.setAttribute("id",           "grid");
    pattern.setAttribute("width",        String(gridSize));
    pattern.setAttribute("height",       String(gridSize));
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    const gridLine = doc.createElementNS(svgNS, "path");
    gridLine.setAttribute("d",            `M ${gridSize} 0 L 0 0 0 ${gridSize}`);
    gridLine.setAttribute("fill",         "none");
    gridLine.setAttribute("stroke",       "#ccc");
    gridLine.setAttribute("stroke-width", "0.5");
    pattern.appendChild(gridLine);
    defs.appendChild(pattern);
    svg.appendChild(defs);

    const gridRect = doc.createElementNS(svgNS, "rect");
    gridRect.setAttribute("width",  "100%");
    gridRect.setAttribute("height", "100%");
    gridRect.setAttribute("fill",   "url(#grid)");
    svg.appendChild(gridRect);

    // ── Draw each mat ─────────────────────────────────────────────────────────
    for (const mat of mats) {
      const g = doc.createElementNS(svgNS, "g");
      g.setAttribute("data-id", mat.id);
      (g as unknown as HTMLElement).style.cursor = isLayoutMode ? "move" : "pointer";

      const px = (mat.x + this.offsetX) * this.scale;
      const py = (mat.y + this.offsetY) * this.scale;
      const pw = mat.w * this.scale;
      const ph = mat.h * this.scale;

      if (pw <= 0 || ph <= 0) continue;

      const fillColor   = mat.cp_fillcolor   || "#A0A972";
      const strokeColor = mat.cp_strokecolor || "#383838";
      const strokeWidth = 3 * this.scale;

      const rect = doc.createElementNS(svgNS, "rect");
      rect.setAttribute("x",            String(px));
      rect.setAttribute("y",            String(py));
      rect.setAttribute("width",        String(pw));
      rect.setAttribute("height",       String(ph));
      rect.setAttribute("fill",         fillColor);
      rect.setAttribute("stroke",       strokeColor);
      rect.setAttribute("stroke-width", String(strokeWidth));
      rect.setAttribute("rx",           "4");
      g.appendChild(rect);

      const label = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : "");
      if (label) {
        const fontSize = Math.max(10, Math.min(14, pw / 5)) * this.scale;
        const text = doc.createElementNS(svgNS, "text");
        text.setAttribute("x",                 String(px + pw / 2));
        text.setAttribute("y",                 String(py + ph / 2));
        text.setAttribute("text-anchor",       "middle");
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-size",         String(fontSize));
        text.setAttribute("font-family",       "Segoe UI, sans-serif");
        text.setAttribute("fill",              "#fff");
        text.setAttribute("pointer-events",    "none");
        text.textContent = label;
        g.appendChild(text);
      }

      // ── Breathing round indicator — small badge in the top-right corner ─────
      // Green once cp_breathinground is true on the linked check-in, amber otherwise.
      // Inset from the corner by radius + half the stroke width so the whole
      // badge (including its stroke) sits fully inside the mat's rectangle.
      const breathingDone     = !!mat.checkinId && this.breathingRoundById.get(mat.checkinId) === true;
      const badgeRadius       = Math.max(6, Math.min(12, Math.min(pw, ph) / 3)) * this.scale;
      const badgeStrokeWidth  = 3 * this.scale;
      const badgeInset        = badgeRadius + badgeStrokeWidth / 2;
      const badge = doc.createElementNS(svgNS, "circle");
      badge.setAttribute("cx",           String(px + pw - badgeInset));
      badge.setAttribute("cy",           String(py + badgeInset));
      badge.setAttribute("r",            String(badgeRadius));
      badge.setAttribute("fill",         breathingDone ? "#00E676" : "#FFC400");
      badge.setAttribute("stroke",       "#fff");
      badge.setAttribute("stroke-width", String(badgeStrokeWidth));
      badge.setAttribute("pointer-events", "none");
      g.appendChild(badge);

      if (isLayoutMode) {
        // ── Layout mode: drag to reposition ───────────────────────────────
        g.addEventListener("mousedown", (e: MouseEvent) => {
          e.preventDefault();
          this.dragging    = true;
          this.dragMatId   = mat.id;
          const svgRect    = (svg as unknown as HTMLElement).getBoundingClientRect();
          this.dragOffsetX = (e.clientX - svgRect.left) / this.scale - mat.x - this.offsetX;
          this.dragOffsetY = (e.clientY - svgRect.top)  / this.scale - mat.y - this.offsetY;
          this.dragStartX  = mat.x;
          this.dragStartY  = mat.y;
        });
      } else {
        // ── Normal mode: left-click behaviour depends on assignment state ──
        //
        //   Mat HAS a check-in assigned → show removal dialog
        //   Mat has NO check-in         → open Xrm lookup to assign one
        //
        g.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation(); // prevent SVG background click from dismissing immediately
          if (mat.hasCheckin) {
            this.showRemoveDialog(mat, e.clientX, e.clientY);
          } else {
            this.pickAndAssign(mat).catch((err: unknown) => {
              console.error("[MatsOverlay] pickAndAssign error:", err);
            });
          }
        });
      }

      svg.appendChild(g);
    }

    // ── Drag events ───────────────────────────────────────────────────────────
    svg.addEventListener("mousemove", (e: MouseEvent) => {
      if (!this.dragging) return;
      const svgRect = (svg as unknown as HTMLElement).getBoundingClientRect();
      const rawX  = (e.clientX - svgRect.left) / this.scale - this.offsetX - this.dragOffsetX;
      const rawY  = (e.clientY - svgRect.top)  / this.scale - this.offsetY - this.dragOffsetY;
      const snapX = Math.round(rawX / 5) * 5;
      const snapY = Math.round(rawY / 5) * 5;

      const draggedG = svg.querySelector(`g[data-id="${this.dragMatId}"]`) as SVGGElement | null;
      if (draggedG) {
        const mat = this.currentMats.find(m => m.id === this.dragMatId);
        if (mat) {
          draggedG.setAttribute(
            "transform",
            `translate(${(snapX - mat.x) * this.scale},${(snapY - mat.y) * this.scale})`
          );
        }
      }
      this.newX = snapX;
      this.newY = snapY;
    });

    svg.addEventListener("mouseup", () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.newX !== this.dragStartX || this.newY !== this.dragStartY) {
        this.selectedId = this.dragMatId;
        this.changeKind = "move";
        this.notifyOutputChanged();
      }
    });

    svg.addEventListener("mouseleave", () => { this.dragging = false; });

    // Clicking the SVG background dismisses any open removal dialog
    svg.addEventListener("click", () => {
      this.dismissRemoveDialog();
    });

    wrapper.appendChild(svg);

    // ── Overlap warning ───────────────────────────────────────────────────────
    if (overlaps.length > 0) {
      const banner = doc.createElement("div");
      banner.style.cssText = `
        background:#fff3cd; border:1px solid #ffc107;
        color:#856404; padding:8px 12px; font-size:13px;
        font-family:Segoe UI,sans-serif; margin-top:6px;
        border-radius:4px; white-space:pre-wrap;
      `;
      banner.textContent = `⚠️ Overlaps detected:\n${overlaps.map(o => `  • ${o}`).join("\n")}`;
      wrapper.appendChild(banner);
    }

    this.container.appendChild(wrapper);
  }

  // ── Remove dialog ────────────────────────────────────────────────────────────

  /**
   * Floating dialog shown when a mat that already has a check-in is clicked.
   * Lets the user selectively remove the check-in, the client, or both.
   */
  private showRemoveDialog(mat: MatRow, clientX: number, clientY: number): void {
    this.dismissRemoveDialog();

    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);
    const doc      = this.container.ownerDocument!;

    // Transparent backdrop — clicks outside dismiss the dialog
    const backdrop = doc.createElement("div");
    backdrop.id = "matsOverlay-remove-backdrop";
    backdrop.style.cssText = "position:fixed;inset:0;z-index:99998;background:transparent;";
    backdrop.addEventListener("click", () => this.dismissRemoveDialog());

    // Floating panel
    const menu = doc.createElement("div");
    menu.id = "matsOverlay-remove-menu";
    menu.style.cssText = `
      position:fixed; left:${clientX}px; top:${clientY}px;
      z-index:99999; background:#fff;
      border:1px solid #d0d0d0; border-radius:8px;
      box-shadow:0 6px 24px rgba(0,0,0,0.18);
      font-family:Segoe UI,sans-serif; font-size:13px;
      min-width:230px; overflow:hidden;
    `;

    // Header
    const header = doc.createElement("div");
    header.style.cssText = `
      background:#2b579a; color:#fff;
      padding:10px 16px; font-weight:600; font-size:13px;
    `;
    header.textContent = `⚙️ ${matLabel} — manage assignment`;
    menu.appendChild(header);

    const divider = (): HTMLElement => {
      const d = doc.createElement("div");
      d.style.cssText = "height:1px;background:#eee;";
      return d;
    };

    const makeBtn = (icon: string, label: string, danger: boolean, onClick: () => void): HTMLElement => {
      const btn = doc.createElement("div");
      btn.style.cssText = `
        padding:11px 16px; cursor:pointer;
        color:${danger ? "#c00" : "#333"};
        display:flex; align-items:center; gap:10px;
        transition:background 0.12s;
      `;
      const iconEl = doc.createElement("span");
      iconEl.textContent = icon;
      iconEl.style.fontSize = "15px";
      const labelEl = doc.createElement("span");
      labelEl.textContent = label;
      btn.appendChild(iconEl);
      btn.appendChild(labelEl);
      btn.addEventListener("mouseenter", () => { btn.style.background = danger ? "#fff5f5" : "#f4f7ff"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "#fff"; });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.dismissRemoveDialog();
        onClick();
      });
      return btn;
    };

    menu.appendChild(makeBtn("🫁", "Complete Breathing Round", false, () => {
      this.completeBreathingRound(mat).catch((err: unknown) => {
        console.error("[MatsOverlay] completeBreathingRound error:", err);
      });
    }));

    menu.appendChild(divider());

    menu.appendChild(makeBtn("🗑️", "Remove Both", true, () => {
      this.removeFields(mat, true, true).catch((err: unknown) => {
        console.error("[MatsOverlay] removeFields error:", err);
      });
    }));

    menu.appendChild(divider());

    menu.appendChild(makeBtn("✕", "Cancel", false, () => { /* already dismissed */ }));

    doc.body.appendChild(backdrop);
    doc.body.appendChild(menu);

    // Nudge inside viewport if it overflows
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = `${clientX - r.width  - 4}px`;
    if (r.bottom > window.innerHeight) menu.style.top  = `${clientY - r.height - 4}px`;
  }

  private dismissRemoveDialog(): void {
    const doc = this.container.ownerDocument!;
    doc.getElementById("matsOverlay-remove-backdrop")?.remove();
    doc.getElementById("matsOverlay-remove-menu")?.remove();
  }

  // ── Remove fields ─────────────────────────────────────────────────────────────

  private async removeFields(
    mat: MatRow,
    removeCheckin: boolean,
    removeClient: boolean
  ): Promise<void> {
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);
    const payload: Record<string, null> = {};

    if (removeCheckin) payload[`${MatsOverlay.NAV_CHECKIN}@odata.bind`] = null;
    if (removeClient)  payload[`${MatsOverlay.NAV_CLIENT}@odata.bind`]  = null;

    console.log(`[MatsOverlay] Clearing from ${matLabel}:`, JSON.stringify(payload));

    await this.context.webAPI.updateRecord("cp_mat", mat.id, payload);

    const what = removeCheckin && removeClient
      ? "Check-in & client removed."
      : removeCheckin ? "Check-in removed." : "Client removed.";

    await this.showAlert(`✅ ${matLabel}: ${what}`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Complete Breathing Round ─────────────────────────────────────────────────

  private async completeBreathingRound(mat: MatRow): Promise<void> {
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);

    let checkinId: Guid;
    try {
      const matRecord = await this.context.webAPI.retrieveRecord(
        "cp_mat",
        mat.id,
        "?$select=_cp_sheltercheckin_value"
      );
      const raw = matRecord["_cp_sheltercheckin_value"] as string | null | undefined;
      if (!raw) {
        await this.showAlert(`⚠️ ${matLabel}: No check-in assigned.`);
        return;
      }
      checkinId = raw.replace(/[{}]/g, "");
    } catch (err) {
      console.error("[MatsOverlay] Could not resolve check-in for breathing round:", err);
      await this.showAlert(`❌ ${matLabel}: Could not resolve check-in record.`);
      return;
    }

    await this.context.webAPI.updateRecord("cp_sheltercheckin", checkinId, { cp_breathinground: true });
    this.breathingRoundById.set(checkinId.toLowerCase(), true);

    await this.showAlert(`✅ ${matLabel}: Breathing round completed.`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Breathing round status cache ─────────────────────────────────────────────

  /**
   * Batches a single query for the cp_breathinground status of all active check-ins,
   * rather than one WebAPI call per mat. Throttled since updateView can fire on
   * every pan/zoom tick; re-renders once if the fetched statuses actually changed.
   */
  private async refreshBreathingRoundIndicators(): Promise<void> {
    const now = Date.now();
    if (this.breathingRoundFetchInFlight || now - this.breathingRoundLastFetch < 2000) return;
    this.breathingRoundFetchInFlight = true;

    try {
      const result = await this.context.webAPI.retrieveMultipleRecords(
        "cp_sheltercheckin",
        "?$select=cp_breathinground&$filter=statecode eq 0"
      );

      const next = new Map<string, boolean>();
      for (const rec of result.entities) {
        const id = (rec["cp_sheltercheckinid"] as string | undefined)?.toLowerCase();
        if (!id) continue;
        next.set(id, rec["cp_breathinground"] === true);
      }
      this.breathingRoundLastFetch = Date.now();

      let changed = next.size !== this.breathingRoundById.size;
      if (!changed) {
        for (const [id, val] of next) {
          if (this.breathingRoundById.get(id) !== val) { changed = true; break; }
        }
      }
      this.breathingRoundById = next;
      if (changed) this.updateView(this.context);
    } catch (err) {
      console.error("[MatsOverlay] Could not load breathing round status:", err);
    } finally {
      this.breathingRoundFetchInFlight = false;
    }
  }

  // ── Pick & Assign (unchanged) ─────────────────────────────────────────────────

  private async pickAndAssign(mat: MatRow): Promise<void> {
    const xrm      = this.getXrm();
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);

    let scPick: LookupResult[];
    try {
      scPick = await xrm.Utility.lookupObjects({
        entityTypes:      ["cp_sheltercheckin"],
        allowMultiSelect: false,
        filters: [{
          entityLogicalName: "cp_sheltercheckin",
          filterXml:
            "<filter type='and'>" +
              "<condition attribute='cp_checkin' operator='eq' value='1' />" +
              "<condition attribute='statecode'  operator='eq' value='0' />" +
            "</filter>"
        }]
      });
    } catch {
      return;
    }
    if (!scPick || scPick.length === 0) return;

    const shelterCheckinId: Guid = scPick[0].id.replace(/[{}]/g, "");

    let contactId: Guid | null = null;
    try {
      const ciRecord = await this.context.webAPI.retrieveRecord(
        "cp_sheltercheckin",
        shelterCheckinId,
        "?$select=_cp_client_value"
      );
      const raw = ciRecord["_cp_client_value"] as string | null | undefined;
      contactId = raw ? raw.replace(/[{}]/g, "") : null;
    } catch (err) {
      console.warn("[MatsOverlay] Could not read _cp_client_value:", err);
    }

    const payload: Record<string, string | null> = {
      [`${MatsOverlay.NAV_CHECKIN}@odata.bind`]:
        `/${MatsOverlay.SET_CHECKIN}(${shelterCheckinId})`,
      [`${MatsOverlay.NAV_CLIENT}@odata.bind`]:
        contactId ? `/${MatsOverlay.SET_CONTACT}(${contactId})` : null,
    };

    console.log(`[MatsOverlay] PATCH cp_mat/${mat.id}:`, JSON.stringify(payload));

    await this.context.webAPI.updateRecord("cp_mat", mat.id, payload);

    const clientMsg = contactId
      ? "Check-in & client assigned."
      : "Check-in assigned (no client linked to this check-in).";
    await this.showAlert(`✅ ${matLabel}: ${clientMsg}`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private async showAlert(text: string, title = "Mats Overlay"): Promise<void> {
    const strings: AlertDialogStrings = { text, title };
    const options: AlertDialogOptions = { height: 150, width: 320 };
    await this.context.navigation.openAlertDialog(strings, options);
  }

  private getXrm(): XrmLike {
    const w = (window as unknown as { Xrm?: XrmLike });
    if (!w.Xrm?.Utility) throw new Error("Xrm.Utility is not available in this context.");
    return w.Xrm;
  }

  public getOutputs(): IOutputs {
    return {
      SelectedId: this.selectedId,
      ChangeKind: this.changeKind,
      NewX:       this.newX,
      NewY:       this.newY,
      NewW:       this.newW,
      NewH:       this.newH,
    };
  }

  public destroy(): void {
    this.dismissRemoveDialog();
    this.container.innerHTML = "";
  }

  private renderStatus(message: string): void {
    this.container.innerHTML = "";
    const doc = this.container.ownerDocument!;
    const pre = doc.createElement("pre");
    pre.style.fontFamily = "Segoe UI, sans-serif";
    pre.style.padding    = "12px";
    pre.textContent      = message;
    this.container.appendChild(pre);
  }

  private readMatsFromDataset(ds: ComponentFramework.PropertyTypes.DataSet): MatRow[] {
    if (!ds?.sortedRecordIds?.length) return [];
    const rows: MatRow[] = [];
    for (const id of ds.sortedRecordIds) {
      const rec = ds.records[id];
      if (!rec) continue;

      const cp_matlabel    = this.getString(rec, "cp_matlabel");
      const cp_matnumber   = this.getNumber(rec, "cp_matnumber");
      const cp_matwidth    = this.getNumber(rec, "cp_matwidth");
      const cp_matheight   = this.getNumber(rec, "cp_matheight");
      const cp_xposition   = this.getNumber(rec, "cp_xposition");
      const cp_yposition   = this.getNumber(rec, "cp_yposition");
      const cp_fillcolor   = this.getString(rec, "cp_fillcolor");
      const cp_strokecolor = this.getString(rec, "cp_strokecolor");

      // Detect whether a check-in is already assigned.
      // The dataset exposes lookup fields as the formatted value string when bound,
      // or we can check the raw value of _cp_sheltercheckin_value.
      // Try both the property-set name and the underlying _value column.
      const checkinRaw = rec.getValue("cp_sheltercheckin");
      const hasCheckin = checkinRaw != null && checkinRaw !== "";

      let checkinId: string | null = null;
      if (checkinRaw && typeof checkinRaw === "object" && "id" in checkinRaw) {
        checkinId = (checkinRaw as ComponentFramework.EntityReference).id.guid
          .replace(/[{}]/g, "")
          .toLowerCase();
      }

      rows.push({
        id,
        cp_matlabel,
        cp_matnumber,
        cp_matwidth,
        cp_matheight,
        cp_xposition,
        cp_yposition,
        cp_fillcolor,
        cp_strokecolor,
        hasCheckin,
        checkinId,
        x: cp_xposition ?? 0,
        y: cp_yposition ?? 0,
        w: cp_matwidth  ?? 0,
        h: cp_matheight ?? 0,
      });
    }
    return rows;
  }

  private getString(
    rec: ComponentFramework.PropertyHelper.DataSetApi.EntityRecord,
    logicalName: string
  ): string | null {
    const raw = rec.getValue(logicalName);
    if (raw == null) return null;
    return String(raw);
  }

  private getNumber(
    rec: ComponentFramework.PropertyHelper.DataSetApi.EntityRecord,
    logicalName: string
  ): number | null {
    const raw = rec.getValue(logicalName);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  private isOverlapping(a: MatRow, b: MatRow): boolean {
    return !(
      a.x + a.w <= b.x ||
      b.x + b.w <= a.x ||
      a.y + a.h <= b.y ||
      b.y + b.h <= a.y
    );
  }

  private findOverlaps(mats: MatRow[]): string[] {
    const issues: string[] = [];
    for (let i = 0; i < mats.length; i++) {
      for (let j = i + 1; j < mats.length; j++) {
        const a = mats[i], b = mats[j];
        if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) continue;
        if (this.isOverlapping(a, b)) {
          const aLabel = a.cp_matlabel ?? (a.cp_matnumber != null ? `Mat ${a.cp_matnumber}` : a.id);
          const bLabel = b.cp_matlabel ?? (b.cp_matnumber != null ? `Mat ${b.cp_matnumber}` : b.id);
          issues.push(`${aLabel} overlaps ${bLabel}`);
        }
      }
    }
    return issues;
  }
}